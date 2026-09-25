//! Validated LUT import and monotone tone curves, shared by UI frontends.

#[derive(Clone, Debug)]
pub struct ColorLut {
    pub size: u32,
    pub domain_min: [f32; 3],
    pub domain_max: [f32; 3],
    pub table: Vec<f32>,
}

impl ColorLut {
    pub fn is_identity(&self) -> bool {
        self.domain_min == [0.; 3]
            && self.domain_max == [1.; 3]
            && self.table.chunks_exact(3).enumerate().all(|(i, rgb)| {
                let size = self.size as usize;
                [i % size, (i / size) % size, i / (size * size)]
                    .iter()
                    .enumerate()
                    .all(|(c, &node)| (rgb[c] - node as f32 / (size - 1) as f32).abs() < 1e-6)
            })
    }
}

fn triple(text: &str) -> Result<[f32; 3], String> {
    let numbers: Result<Vec<f32>, _> = text.split_whitespace().map(str::parse).collect();
    let values = numbers.map_err(|_| "Expected three finite numbers")?;
    if values.len() != 3 || values.iter().any(|v| !v.is_finite()) {
        return Err("Expected three finite numbers".into());
    }
    Ok([values[0], values[1], values[2]])
}

pub fn parse_cube(text: &str) -> Result<ColorLut, String> {
    if text.len() > 16 * 1024 * 1024 {
        return Err("LUT files must be at most 16 MB".into());
    }
    let mut size = None;
    let mut one_d = false;
    let mut min = [0.; 3];
    let mut max = [1.; 3];
    let mut table = Vec::new();
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut tokens = line.splitn(2, char::is_whitespace);
        let keyword = tokens.next().unwrap_or("").to_ascii_uppercase();
        let rest = tokens.next().unwrap_or("").trim();
        match keyword.as_str() {
            "TITLE" => {}
            "LUT_1D_SIZE" | "LUT_3D_SIZE" => {
                if size.is_some() || !table.is_empty() {
                    return Err("Use one LUT size declaration before entries".into());
                }
                let count: u32 = rest.parse().map_err(|_| "Invalid LUT size")?;
                one_d = keyword == "LUT_1D_SIZE";
                let limit = if one_d { 65536 } else { 65 };
                if !(2..=limit).contains(&count) {
                    return Err(format!("LUT size must be between 2 and {limit}"));
                }
                size = Some(count);
            }
            "DOMAIN_MIN" => min = triple(rest)?,
            "DOMAIN_MAX" => max = triple(rest)?,
            _ => {
                let count = size.ok_or("Declare LUT size before entries")? as usize;
                let expected = if one_d { count } else { count.pow(3) } * 3;
                if table.len() >= expected {
                    return Err("Too many LUT entries".into());
                }
                table.extend(triple(line)?);
            }
        }
    }
    let size = size.ok_or("Missing LUT_3D_SIZE or LUT_1D_SIZE")?;
    let expected = if one_d {
        size as usize
    } else {
        (size as usize).pow(3)
    } * 3;
    if table.len() != expected {
        return Err(format!(
            "Expected {} LUT entries, got {}",
            expected / 3,
            table.len() / 3
        ));
    }
    if (0..3).any(|c| max[c] <= min[c] || !(max[c] - min[c]).is_finite()) {
        return Err("Each DOMAIN_MAX must be greater than DOMAIN_MIN".into());
    }
    if !one_d {
        return Ok(ColorLut {
            size,
            table,
            domain_min: min,
            domain_max: max,
        });
    }
    // Separable 1D curves are sampled into the same 3D pipeline. Cap the
    // expansion: a 65536-entry input must never allocate 65536^3 texels.
    let output_size = size.min(65);
    let mut output = Vec::with_capacity(output_size.pow(3) as usize * 3);
    for b in 0..output_size {
        for g in 0..output_size {
            for r in 0..output_size {
                for (channel, node) in [r, g, b].into_iter().enumerate() {
                    let p = node as f32 / (output_size - 1) as f32 * (size - 1) as f32;
                    let lo = p.floor() as usize;
                    let hi = (lo + 1).min(size as usize - 1);
                    let a = table[lo * 3 + channel];
                    output.push(a + (table[hi * 3 + channel] - a) * (p - lo as f32));
                }
            }
        }
    }
    Ok(ColorLut {
        size: output_size,
        table: output,
        domain_min: min,
        domain_max: max,
    })
}

pub struct ToneCurve {
    points: Vec<[f32; 2]>,
    tangents: Vec<f32>,
}

/// Four HSL adjustments packed as 256 RGBA lanes for one GPU pass. The first
/// three lanes are periodic in hue; the last is sampled over linear lightness.
pub struct PreparedHslCurves {
    pub table: Vec<f32>,
    pub is_identity: bool,
}

/// A hue curve shares its endpoint value and tangent across the red seam.
/// This avoids a visible jump when a hue passes through 0/360 degrees.
pub struct PeriodicCurve(ToneCurve);

impl PeriodicCurve {
    pub fn new(points: &[[f32; 2]]) -> Result<Self, String> {
        let mut curve = ToneCurve::new(points)?;
        let first = curve.points.first().unwrap();
        let last = curve.points.last().unwrap();
        if first[0] != 0. || last[0] != 1. || (first[1] - last[1]).abs() > 1e-6 {
            return Err("Hue curves need matching values at 0 and 1".into());
        }
        let n = curve.points.len();
        let left = (curve.points[n - 1][1] - curve.points[n - 2][1])
            / (curve.points[n - 1][0] - curve.points[n - 2][0]);
        let right =
            (curve.points[1][1] - curve.points[0][1]) / (curve.points[1][0] - curve.points[0][0]);
        let seam_tangent = if left * right > 0. {
            ((left + right) * 0.5).clamp(
                -3. * left.abs().min(right.abs()),
                3. * left.abs().min(right.abs()),
            )
        } else {
            0.
        };
        curve.tangents[0] = seam_tangent;
        curve.tangents[n - 1] = seam_tangent;
        Ok(Self(curve))
    }

    pub fn evaluate(&self, hue: f32) -> f32 {
        self.0.evaluate(hue.rem_euclid(1.))
    }
}

pub fn prepare_hsl_curves(points: &[Vec<[f32; 2]>]) -> Result<PreparedHslCurves, String> {
    if points.len() != 4 {
        return Err("Expected hue-vs-hue, hue-vs-sat, hue-vs-lum and lum-vs-sat curves".into());
    }
    let hue_curves: Vec<_> = points[..3]
        .iter()
        .map(|curve| PeriodicCurve::new(curve))
        .collect::<Result<_, _>>()?;
    let lum_curve = ToneCurve::new(&points[3])?;
    if lum_curve.points[0][0] != 0. || lum_curve.points.last().unwrap()[0] != 1. {
        return Err("The lightness curve must cover 0 to 1".into());
    }
    let mut table = Vec::with_capacity(256 * 4);
    for i in 0..256 {
        let hue = i as f32 / 256.;
        for curve in &hue_curves {
            table.push(curve.evaluate(hue));
        }
        table.push(lum_curve.evaluate(i as f32 / 255.));
    }
    Ok(PreparedHslCurves {
        table,
        is_identity: points.iter().flatten().all(|point| point[1] == 0.5),
    })
}

/// CPU pixel reference for the HSL shader, using the same 256-row table and
/// encoded sRGB/HSL conversion. Useful for fixture parity assertions.
pub fn apply_hsl_curves(rgb: [f32; 3], prepared: &PreparedHslCurves) -> [f32; 3] {
    let [r, g, b] = rgb.map(|value| value.clamp(0., 1.));
    let greatest = r.max(g).max(b);
    let least = r.min(g).min(b);
    let chroma = greatest - least;
    let lightness = (greatest + least) * 0.5;
    let (hue, saturation) = if chroma < 0.000001 {
        (0., 0.)
    } else {
        let hue = if greatest == r {
            (g - b) / chroma
        } else if greatest == g {
            (b - r) / chroma + 2.
        } else {
            (r - g) / chroma + 4.
        };
        (
            (hue / 6. + 1.).fract(),
            chroma / (1. - (2. * lightness - 1.).abs()).max(0.000001),
        )
    };
    let sample = |channel: usize, position: f32| -> f32 {
        let p = if channel == 3 {
            position.clamp(0., 1.) * 255.
        } else {
            position.fract() * 256.
        };
        let low = p.floor() as usize;
        let high = if channel == 3 {
            (low + 1).min(255)
        } else {
            (low + 1) % 256
        };
        let a = prepared.table[low * 4 + channel];
        let b = prepared.table[high * 4 + channel];
        a + (b - a) * p.fract()
    };
    let saturation = (saturation * 2. * sample(1, hue) * 2. * sample(3, lightness)).clamp(0., 1.);
    let lightness = (lightness + sample(2, hue) - 0.5).clamp(0., 1.);
    let hue = (hue + sample(0, hue) - 0.5 + 1.).fract();
    let hue_channel = |offset: f32| {
        let k = ((offset + hue * 12.) / 12.).fract() * 12.;
        let a = saturation * lightness.min(1. - lightness);
        lightness - a * (-1_f32).max((k - 3.).min((9. - k).min(1.)))
    };
    [hue_channel(0.), hue_channel(8.), hue_channel(4.)]
}

/// Four separable cubic curves prepared for the GPU's analytic `tone-curves`
/// shader. Every curve owns 32 vec4 lanes (`x`, `y`, tangent, padding). Keeping
/// the control points preserves narrow transitions that a sampled 3D LUT loses.
pub struct PreparedCurves {
    pub counts: [f32; 4],
    pub nodes: Vec<f32>,
    pub is_identity: bool,
}

pub fn prepare_curves(points: &[Vec<[f32; 2]>]) -> Result<PreparedCurves, String> {
    if points.len() != 4 {
        return Err("Expected master, red, green and blue curves".into());
    }
    let curves: Vec<_> = points
        .iter()
        .map(|curve| ToneCurve::new(curve))
        .collect::<Result<_, _>>()?;
    let mut counts = [0.; 4];
    let mut nodes = vec![0.; 4 * 32 * 4];
    let mut is_identity = true;
    for (channel, curve) in curves.iter().enumerate() {
        counts[channel] = curve.points.len() as f32;
        is_identity &=
            curve.points.first().unwrap()[0] == 0. && curve.points.last().unwrap()[0] == 1.;
        for (index, ([x, y], tangent)) in curve.points.iter().zip(&curve.tangents).enumerate() {
            let offset = (channel * 32 + index) * 4;
            nodes[offset..offset + 3].copy_from_slice(&[*x, *y, *tangent]);
            is_identity &= x == y;
        }
    }
    Ok(PreparedCurves {
        counts,
        nodes,
        is_identity,
    })
}

impl ToneCurve {
    pub fn new(points: &[[f32; 2]]) -> Result<Self, String> {
        if points.len() < 2
            || points.len() > 32
            || points
                .iter()
                .flatten()
                .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
        {
            return Err("A curve needs 2–32 finite points in [0, 1]".into());
        }
        let mut points = points.to_vec();
        points.sort_by(|a, b| a[0].total_cmp(&b[0]));
        if points.windows(2).any(|p| p[1][0] - p[0][0] < 0.0001) {
            return Err("Curve input positions must be distinct".into());
        }
        let n = points.len();
        let slopes: Vec<f32> = points
            .windows(2)
            .map(|p| (p[1][1] - p[0][1]) / (p[1][0] - p[0][0]))
            .collect();
        let mut tangents = vec![0.; n];
        tangents[0] = slopes[0];
        tangents[n - 1] = slopes[n - 2];
        for i in 1..n - 1 {
            if slopes[i - 1] * slopes[i] > 0. {
                tangents[i] = (slopes[i - 1] + slopes[i]) / 2.;
            }
        }
        for i in 0..n - 1 {
            if slopes[i] == 0. {
                tangents[i] = 0.;
                tangents[i + 1] = 0.;
                continue;
            }
            let magnitude =
                (tangents[i] / slopes[i]).powi(2) + (tangents[i + 1] / slopes[i]).powi(2);
            if magnitude > 9. {
                let tau = 3. / magnitude.sqrt();
                tangents[i] *= tau;
                tangents[i + 1] *= tau;
            }
        }
        Ok(Self { points, tangents })
    }
    pub fn evaluate(&self, x: f32) -> f32 {
        let n = self.points.len();
        if x <= self.points[0][0] {
            return self.points[0][1];
        }
        if x >= self.points[n - 1][0] {
            return self.points[n - 1][1];
        }
        let hi = self.points.partition_point(|p| p[0] <= x);
        let lo = hi - 1;
        let h = self.points[hi][0] - self.points[lo][0];
        let t = (x - self.points[lo][0]) / h;
        let t2 = t * t;
        let t3 = t2 * t;
        ((2. * t3 - 3. * t2 + 1.) * self.points[lo][1]
            + (t3 - 2. * t2 + t) * h * self.tangents[lo]
            + (-2. * t3 + 3. * t2) * self.points[hi][1]
            + (t3 - t2) * h * self.tangents[hi])
            .clamp(0., 1.)
    }
}

pub fn bake_curves(points: &[Vec<[f32; 2]>]) -> Result<ColorLut, String> {
    if points.len() != 4 {
        return Err("Expected master, red, green and blue curves".into());
    }
    let curves: Result<Vec<_>, _> = points.iter().map(|p| ToneCurve::new(p)).collect();
    let curves = curves?;
    let size = 33u32;
    let mut table = Vec::with_capacity(size.pow(3) as usize * 3);
    for b in 0..size {
        for g in 0..size {
            for r in 0..size {
                for (channel, node) in [r, g, b].into_iter().enumerate() {
                    table.push(
                        curves[channel + 1]
                            .evaluate(curves[0].evaluate(node as f32 / (size - 1) as f32)),
                    );
                }
            }
        }
    }
    Ok(ColorLut {
        size,
        table,
        domain_min: [0.; 3],
        domain_max: [1.; 3],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cube() -> String {
        "TITLE \"identity\"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1"
            .into()
    }
    #[test]
    fn cube_validation() {
        assert_eq!(parse_cube(&cube()).unwrap().table.len(), 24);
        assert!(parse_cube(&(cube() + "\n1 1 1")).is_err());
        assert!(parse_cube("LUT_3D_SIZE 1000000000").is_err());
        assert!(parse_cube(&(cube() + "\nDOMAIN_MAX 0 1 1")).is_err());
        assert!(parse_cube(&cube().replace("0 0 0", "NaN 0 0")).is_err());
        assert!(
            parse_cube(&cube().replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nLUT_1D_SIZE 2")).is_err()
        );
    }
    #[test]
    fn domains_and_one_d() {
        let lut = parse_cube(
            "LUT_1D_SIZE 2 # comment\nDOMAIN_MIN -1 -1 -1\nDOMAIN_MAX 2 2 2\n1 0 0\n0 1 1",
        )
        .unwrap();
        assert_eq!(lut.domain_min, [-1.; 3]);
        assert_eq!(&lut.table[..6], &[1., 0., 0., 0., 0., 0.]);
    }
    #[test]
    fn curve_monotonicity_and_bounds() {
        let curve = ToneCurve::new(&[[0., 0.], [0.1, 0.7], [0.6, 0.8], [1., 1.]]).unwrap();
        let mut prev = 0.;
        for i in 0..1024 {
            let y = curve.evaluate(i as f32 / 1023.);
            assert!(y >= prev && (0.0..=1.0).contains(&y));
            prev = y;
        }
        assert!(ToneCurve::new(&[[0., 0.], [0., 1.]]).is_err());
    }
    #[test]
    fn baked_identity_and_channel_order() {
        let identity = vec![[0., 0.], [1., 1.]];
        let mut curves = vec![identity; 4];
        let lut = bake_curves(&curves).unwrap();
        assert_eq!(&lut.table[3..6], &[1. / 32., 0., 0.]);
        curves[1] = vec![[0., 1.], [1., 0.]];
        let lut = bake_curves(&curves).unwrap();
        assert_eq!(&lut.table[..3], &[1., 0., 0.]);
    }

    #[test]
    fn prepared_curves_preserve_narrow_transitions() {
        let identity = vec![[0., 0.], [1., 1.]];
        let mut points = vec![identity; 4];
        assert!(prepare_curves(&points).unwrap().is_identity);
        points[0] = vec![[0.2, 0.2], [0.8, 0.8]];
        assert!(!prepare_curves(&points).unwrap().is_identity);
        points[0] = vec![[0., 0.], [0.5, 0.], [0.51, 1.], [1., 1.]];
        points[1] = vec![[0., 1.], [1., 0.]];
        let prepared = prepare_curves(&points).unwrap();
        assert!(!prepared.is_identity);
        assert_eq!(prepared.counts, [4., 2., 2., 2.]);
        assert_eq!(prepared.nodes.len(), 512);
        assert_eq!(&prepared.nodes[4..7], &[0.5, 0., 0.]);
        assert_eq!(&prepared.nodes[8..11], &[0.51, 1., 0.]);
        assert_eq!(&prepared.nodes[128..131], &[0., 1., -1.]);

        let source = 0.505;
        let curve = ToneCurve::new(&points[0]).unwrap();
        let expected = curve.evaluate(source);
        let lo = &prepared.nodes[4..8];
        let hi = &prepared.nodes[8..12];
        let h = hi[0] - lo[0];
        let t = (source - lo[0]) / h;
        let packed = (2. * t.powi(3) - 3. * t.powi(2) + 1.) * lo[1]
            + (t.powi(3) - 2. * t.powi(2) + t) * h * lo[2]
            + (-2. * t.powi(3) + 3. * t.powi(2)) * hi[1]
            + (t.powi(3) - t.powi(2)) * h * hi[2];
        assert!((packed - expected).abs() < 1e-6);
        assert!((packed - 0.5).abs() < 1e-5);
    }

    #[test]
    fn periodic_hue_curve_wraps_with_a_continuous_slope() {
        let curve = PeriodicCurve::new(&[[0., 0.5], [0.2, 0.9], [0.8, 0.1], [1., 0.5]]).unwrap();
        assert!((curve.evaluate(0.9999) - curve.evaluate(-0.0001)).abs() < 1e-6);
        assert!((curve.evaluate(0.) - curve.evaluate(1.)).abs() < 1e-6);
        let left = (curve.evaluate(0.) - curve.evaluate(-0.001)) / 0.001;
        let right = (curve.evaluate(0.001) - curve.evaluate(0.)) / 0.001;
        assert!(
            (left - right).abs() < 0.05,
            "seam slopes differ: {left} and {right}"
        );
        assert!(PeriodicCurve::new(&[[0., 0.2], [1., 0.8]]).is_err());
    }

    #[test]
    fn hsl_table_has_four_lanes_and_a_neutral_default() {
        let neutral = vec![[0., 0.5], [1., 0.5]];
        let mut points = vec![neutral; 4];
        let prepared = prepare_hsl_curves(&points).unwrap();
        assert!(prepared.is_identity);
        assert_eq!(prepared.table.len(), 1024);
        assert!(prepared.table.iter().all(|value| *value == 0.5));

        points[1] = vec![[0., 0.5], [0.5, 1.], [1., 0.5]];
        let prepared = prepare_hsl_curves(&points).unwrap();
        assert!(!prepared.is_identity);
        assert!((prepared.table[128 * 4 + 1] - 1.).abs() < 1e-6);
        assert_eq!(prepared.table[0], 0.5);
        assert_eq!(prepared.table[255 * 4 + 3], 0.5);
    }

    #[test]
    fn hsl_reference_rotates_a_known_red_pixel_to_green() {
        let neutral = vec![[0., 0.5], [1., 0.5]];
        let mut points = vec![neutral; 4];
        points[0] = vec![[0., 0.5 + 1. / 3.], [1., 0.5 + 1. / 3.]];
        let prepared = prepare_hsl_curves(&points).unwrap();
        let result = apply_hsl_curves([1., 0., 0.], &prepared);
        assert!(result[0] < 1e-5 && (result[1] - 1.).abs() < 1e-5 && result[2] < 1e-5);
        let grey = apply_hsl_curves([0.4; 3], &prepared);
        assert!(grey.iter().all(|channel| (*channel - 0.4).abs() < 1e-5));
    }
}
