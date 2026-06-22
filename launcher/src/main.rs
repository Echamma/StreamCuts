#![cfg_attr(not(windows), allow(unused))]

#[cfg(not(windows))]
fn main() {
    eprintln!("StreamCutsLauncher is only supported on Windows.");
    std::process::exit(1);
}

#[cfg(windows)]
mod app {
    use std::env;
    use std::ffi::c_void;
    use std::io::{self, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, ExitStatus, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    const BACKEND_PORT: u16 = 4000;
    const FRONTEND_PORT: u16 = 3000;
    const READY_TIMEOUT: Duration = Duration::from_secs(60);
    const POLL_INTERVAL: Duration = Duration::from_millis(500);

    const DEFAULT_ENV: [(&str, &str); 12] = [
        ("NEXT_PUBLIC_SITE_URL", "http://localhost:3000"),
        ("NEXT_PUBLIC_MARBLE_API_URL", "https://example.com"),
        ("DATABASE_URL", "postgres://user:pass@localhost:5432/opencut"),
        ("BETTER_AUTH_SECRET", "dev-secret"),
        ("UPSTASH_REDIS_REST_URL", "https://example.com"),
        ("UPSTASH_REDIS_REST_TOKEN", "dev-token"),
        ("MARBLE_WORKSPACE_KEY", "dev-workspace"),
        ("FREESOUND_CLIENT_ID", "dev-client"),
        ("FREESOUND_API_KEY", "dev-key"),
        ("NEXT_PUBLIC_LONG_TO_SHORT_API_URL", "http://localhost:4000"),
        ("PYTHON_BIN", "python"),
        ("FASTER_WHISPER_MODEL", "medium"),
    ];

    const BACKEND_ONLY_ENV: [(&str, &str); 4] = [
        ("FASTER_WHISPER_DEVICE", "cpu"),
        ("FASTER_WHISPER_COMPUTE_TYPE", "int8"),
        ("PORT", "4000"),
        ("FRONTEND_ORIGIN", "http://localhost:3000"),
    ];

    pub fn run() -> Result<(), String> {
        let repo_root = find_repo_root()?;
        let paths = AppPaths::from_repo_root(repo_root);

        ensure_ports_available()?;
        check_node_available()?;
        paths.check_prerequisites()?;

        println!("Starting StreamCuts launcher from {}", paths.repo_root.display());

        let job = JobObject::new().map_err(format_io("Failed to create Windows job object"))?;

        println!("Starting long-to-short backend on http://localhost:{BACKEND_PORT}");
        let mut backend = spawn_backend(&paths)?;
        job.assign(&backend)
            .map_err(format_io("Failed to track backend process"))?;
        wait_for_http_ready(
            "backend",
            &mut backend,
            BACKEND_PORT,
            "/api/health",
            READY_TIMEOUT,
        )?;

        println!("Starting frontend on http://localhost:{FRONTEND_PORT}");
        let mut frontend = spawn_frontend(&paths)?;
        job.assign(&frontend)
            .map_err(format_io("Failed to track frontend process"))?;
        wait_for_http_ready(
            "frontend",
            &mut frontend,
            FRONTEND_PORT,
            "/",
            READY_TIMEOUT,
        )?;

        open_browser("http://localhost:3000")
            .map_err(format_io("Failed to open the browser automatically"))?;

        println!("StreamCuts is ready at http://localhost:3000");
        println!("Close this window to stop the local services.");

        wait_for_exit(&mut backend, &mut frontend)
    }

    struct AppPaths {
        repo_root: PathBuf,
        backend_dir: PathBuf,
        backend_entry: PathBuf,
        backend_node_modules: PathBuf,
        web_dir: PathBuf,
        web_build_id: PathBuf,
        web_node_modules: PathBuf,
    }

    impl AppPaths {
        fn from_repo_root(repo_root: PathBuf) -> Self {
            let backend_dir = repo_root.join("backend").join("long-to-short");
            let web_dir = repo_root
                .join("opencut-classic")
                .join("apps")
                .join("web");

            Self {
                backend_entry: backend_dir.join("dist").join("main.js"),
                backend_node_modules: backend_dir.join("node_modules"),
                web_build_id: web_dir.join(".next").join("BUILD_ID"),
                web_node_modules: web_dir.join("node_modules"),
                repo_root,
                backend_dir,
                web_dir,
            }
        }

        fn check_prerequisites(&self) -> Result<(), String> {
            let mut issues = Vec::new();

            if !self.backend_node_modules.is_dir() {
                issues.push(format!(
                    "Backend dependencies are missing: {}",
                    self.backend_node_modules.display()
                ));
            }

            if !self.backend_entry.is_file() {
                issues.push(format!(
                    "Backend build output is missing: {}",
                    self.backend_entry.display()
                ));
            }

            if !self.web_node_modules.is_dir() {
                issues.push(format!(
                    "Frontend dependencies are missing: {}",
                    self.web_node_modules.display()
                ));
            }

            if !self.web_build_id.is_file() {
                issues.push(format!(
                    "Frontend production build is missing: {}",
                    self.web_build_id.display()
                ));
            }

            if issues.is_empty() {
                return Ok(());
            }

            let mut message = String::from("StreamCuts is not prepared for launcher startup.\n\n");
            for issue in issues {
                message.push_str("- ");
                message.push_str(&issue);
                message.push('\n');
            }

            message.push_str("\nRun this once in PowerShell:\n");
            message.push_str("  Set-Location ");
            message.push_str(&escape_powershell_path(&self.repo_root));
            message.push('\n');
            message.push_str("  powershell -ExecutionPolicy Bypass -File .\\script\\prepare-windows-launcher.ps1\n");

            Err(message)
        }
    }

    fn wait_for_exit(backend: &mut Child, frontend: &mut Child) -> Result<(), String> {
        loop {
            if let Some(status) = backend.try_wait().map_err(format_io("Failed to check backend status"))? {
                return Err(format!(
                    "Backend exited unexpectedly with {}.",
                    format_exit_status(status)
                ));
            }

            if let Some(status) = frontend
                .try_wait()
                .map_err(format_io("Failed to check frontend status"))?
            {
                return Err(format!(
                    "Frontend exited unexpectedly with {}.",
                    format_exit_status(status)
                ));
            }

            thread::sleep(POLL_INTERVAL);
        }
    }

    fn spawn_backend(paths: &AppPaths) -> Result<Child, String> {
        let mut command = Command::new("node");
        command
            .arg("dist/main.js")
            .current_dir(&paths.backend_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        apply_default_env(&mut command, &DEFAULT_ENV);
        apply_default_env(&mut command, &BACKEND_ONLY_ENV);
        command
            .spawn()
            .map_err(format_io("Failed to start the backend process"))
    }

    fn spawn_frontend(paths: &AppPaths) -> Result<Child, String> {
        let mut command = Command::new("npm.cmd");
        command
            .args(["run", "start", "--", "--port", "3000"])
            .current_dir(&paths.web_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        apply_default_env(&mut command, &DEFAULT_ENV);
        command.env("NODE_ENV", "production");
        command
            .spawn()
            .map_err(format_io("Failed to start the frontend process"))
    }

    fn apply_default_env(command: &mut Command, defaults: &[(&str, &str)]) {
        for (key, value) in defaults {
            if env::var_os(key).is_none() {
                command.env(key, value);
            }
        }
    }

    fn check_node_available() -> Result<(), String> {
        check_command_available("node", "--version", "Node.js")?;
        check_command_available("npm.cmd", "--version", "npm")?;
        Ok(())
    }

    fn check_command_available(binary: &str, arg: &str, label: &str) -> Result<(), String> {
        let status = Command::new(binary)
            .arg(arg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        match status {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!(
                "{label} was found but failed its self-check with {}.",
                format_exit_status(status)
            )),
            Err(_) => Err(format!(
                "{label} was not found on PATH. Install Node.js and reopen the launcher."
            )),
        }
    }

    fn ensure_ports_available() -> Result<(), String> {
        ensure_port_available(BACKEND_PORT, "backend")?;
        ensure_port_available(FRONTEND_PORT, "frontend")?;
        Ok(())
    }

    fn ensure_port_available(port: u16, label: &str) -> Result<(), String> {
        TcpListener::bind(("127.0.0.1", port))
            .map(drop)
            .map_err(|_| {
                format!(
                    "Port {port} is already in use, so the {label} cannot start. Close the process using that port and try again."
                )
            })
    }

    fn wait_for_http_ready(
        label: &str,
        child: &mut Child,
        port: u16,
        path: &str,
        timeout: Duration,
    ) -> Result<(), String> {
        let started = Instant::now();

        while started.elapsed() < timeout {
            if let Some(status) = child
                .try_wait()
                .map_err(format_io("Failed while monitoring child process"))?
            {
                return Err(format!(
                    "{label} exited before becoming ready with {}.",
                    format_exit_status(status)
                ));
            }

            if http_get_ready(port, path).unwrap_or(false) {
                return Ok(());
            }

            thread::sleep(POLL_INTERVAL);
        }

        Err(format!(
            "Timed out waiting for the {label} on http://localhost:{port}{path}."
        ))
    }

    fn http_get_ready(port: u16, path: &str) -> io::Result<bool> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;

        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes())?;

        let mut response = String::new();
        stream.read_to_string(&mut response)?;

        let Some(status_line) = response.lines().next() else {
            return Ok(false);
        };

        Ok(status_line.starts_with("HTTP/1.1 2")
            || status_line.starts_with("HTTP/1.1 3")
            || status_line.starts_with("HTTP/1.0 2")
            || status_line.starts_with("HTTP/1.0 3"))
    }

    fn open_browser(url: &str) -> io::Result<()> {
        Command::new("cmd")
            .args(["/C", "start", "", url])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
    }

    fn find_repo_root() -> Result<PathBuf, String> {
        let executable = env::current_exe()
            .map_err(|error| format!("Failed to locate the launcher executable: {error}"))?;

        for candidate in executable.ancestors().filter(|path| path.is_dir()) {
            if candidate.join("backend").join("long-to-short").is_dir()
                && candidate
                    .join("opencut-classic")
                    .join("apps")
                    .join("web")
                    .is_dir()
            {
                return Ok(candidate.to_path_buf());
            }
        }

        Err(format!(
            "Could not locate the repo root from {}. Keep the launcher inside the StreamCuts checkout.",
            executable.display()
        ))
    }

    fn escape_powershell_path(path: &Path) -> String {
        let display = path.display().to_string().replace('\'', "''");
        format!("'{}'", display)
    }

    fn format_exit_status(status: ExitStatus) -> String {
        match status.code() {
            Some(code) => format!("exit code {code}"),
            None => String::from("signal termination"),
        }
    }

    fn format_io(prefix: &'static str) -> impl Fn(io::Error) -> String {
        move |error| format!("{prefix}: {error}")
    }

    struct JobObject {
        handle: HANDLE,
    }

    impl JobObject {
        fn new() -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };

            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let result = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &mut info as *mut _ as *mut c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };

            if result == 0 {
                unsafe {
                    CloseHandle(handle);
                }
                return Err(io::Error::last_os_error());
            }

            Ok(Self { handle })
        }

        fn assign(&self, child: &Child) -> io::Result<()> {
            let process_handle = child.as_raw_handle() as HANDLE;
            let result = unsafe { AssignProcessToJobObject(self.handle, process_handle) };

            if result == 0 {
                return Err(io::Error::last_os_error());
            }

            Ok(())
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(windows)]
fn main() {
    if let Err(message) = app::run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}
