//! Single-pole IIR low-pass smoother for the saliency signal.
//!
//! `y_n = alpha * x_n + (1 - alpha) * y_{n-1}`
//!
//! `alpha` is derived from a cutoff frequency expressed as the smoothing
//! time constant in seconds: `alpha = dt / (dt + tau)`. With the default
//! `tau = 0.5s` and a 4 Hz sample rate (`dt = 0.25s`), alpha ≈ 0.33 —
//! enough to ride out a single noisy sample without lag-locking the
//! anchor when a speaker actually moves.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct SmoothingOptions {
    /// Smoothing time constant in seconds. Larger = more smoothing, more lag.
    pub tau_seconds: f64,
    /// Sample interval in seconds (1 / sample_rate_hz).
    pub dt_seconds: f64,
}

impl Default for SmoothingOptions {
    fn default() -> Self {
        Self {
            tau_seconds: 0.5,
            dt_seconds: 0.25,
        }
    }
}

impl SmoothingOptions {
    /// Compute the IIR coefficient. Clamped to [0, 1].
    pub fn alpha(&self) -> f64 {
        if self.dt_seconds <= 0.0 || self.tau_seconds <= 0.0 {
            return 1.0;
        }
        let a = self.dt_seconds / (self.dt_seconds + self.tau_seconds);
        a.clamp(0.0, 1.0)
    }
}

pub struct LowPassSmoother {
    alpha: f64,
    state: Option<f64>,
}

impl LowPassSmoother {
    pub fn new(options: SmoothingOptions) -> Self {
        Self {
            alpha: options.alpha(),
            state: None,
        }
    }

    pub fn push(&mut self, sample: f64) -> f64 {
        let next = match self.state {
            None => sample,
            Some(prev) => self.alpha * sample + (1.0 - self.alpha) * prev,
        };
        self.state = Some(next);
        next
    }

    pub fn last(&self) -> Option<f64> {
        self.state
    }

    pub fn reset(&mut self) {
        self.state = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_for_default_options_is_one_third() {
        let alpha = SmoothingOptions::default().alpha();
        // tau=0.5, dt=0.25 → alpha = 0.25 / 0.75 = 1/3
        assert!((alpha - 1.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn zero_or_negative_tau_short_circuits_to_passthrough() {
        let alpha = SmoothingOptions {
            tau_seconds: 0.0,
            dt_seconds: 0.25,
        }
        .alpha();
        assert_eq!(alpha, 1.0);
    }

    #[test]
    fn first_sample_passes_through_unfiltered() {
        let mut s = LowPassSmoother::new(SmoothingOptions::default());
        assert_eq!(s.push(0.7), 0.7);
    }

    #[test]
    fn steady_input_converges_to_input() {
        let mut s = LowPassSmoother::new(SmoothingOptions::default());
        for _ in 0..100 {
            s.push(0.5);
        }
        let last = s.last().unwrap();
        assert!((last - 0.5).abs() < 1e-6);
    }

    #[test]
    fn step_response_lags_target() {
        let mut s = LowPassSmoother::new(SmoothingOptions::default());
        s.push(0.0);
        let after_step = s.push(1.0);
        // After one step with alpha=1/3: 1/3 * 1.0 + 2/3 * 0.0 = 0.333…
        assert!((after_step - 1.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn passthrough_when_alpha_is_one() {
        let mut s = LowPassSmoother::new(SmoothingOptions {
            tau_seconds: 0.0,
            dt_seconds: 0.25,
        });
        assert_eq!(s.push(0.2), 0.2);
        assert_eq!(s.push(0.9), 0.9);
    }

    #[test]
    fn reset_clears_state() {
        let mut s = LowPassSmoother::new(SmoothingOptions::default());
        s.push(0.5);
        s.reset();
        assert_eq!(s.last(), None);
        assert_eq!(s.push(0.1), 0.1);
    }
}
