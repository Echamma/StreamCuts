//! CPU reductions for color scopes. The caller owns the sampled RGBA frame;
//! these functions only bin pixels and can be shared by any frontend.

const LUMA_R: f32 = 0.2126;
const LUMA_G: f32 = 0.7152;
const LUMA_B: f32 = 0.0722;

#[derive(Debug, PartialEq, Eq)]
pub struct RgbParade {
    /// Three consecutive column-major planes: red, green, blue.
    pub counts: Vec<u32>,
    pub columns: usize,
    pub bins: usize,
    /// Shared maximum for equal intensity across channels.
    pub peak: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Vectorscope {
    /// Row-major Cb/Cr bins, with positive Cr at the top.
    pub counts: Vec<u32>,
    pub size: usize,
    pub peak: u32,
}

fn validate_sample(pixels: &[u8], width: usize, height: usize) -> Result<(), &'static str> {
    let expected = width
        .checked_mul(height)
        .and_then(|count| count.checked_mul(4))
        .ok_or("sample dimensions overflow")?;
    if pixels.len() != expected {
        return Err("sample byte length does not match dimensions");
    }
    Ok(())
}

pub fn compute_rgb_parade(
    pixels: &[u8],
    width: usize,
    height: usize,
    columns: usize,
    bins: usize,
) -> Result<RgbParade, &'static str> {
    if columns == 0 || bins == 0 {
        return Err("parade columns and bins must be positive");
    }
    validate_sample(pixels, width, height)?;
    let len = columns
        .checked_mul(bins)
        .and_then(|plane| plane.checked_mul(3))
        .ok_or("parade dimensions overflow")?;
    let mut result = RgbParade {
        counts: vec![0; len],
        columns,
        bins,
        peak: 0,
    };
    if width == 0 || height == 0 {
        return Ok(result);
    }

    let plane_len = columns * bins;
    for (index, pixel) in pixels.chunks_exact(4).enumerate() {
        let x = index % width;
        let column = x * columns / width;
        for (channel, value) in pixel[..3].iter().enumerate() {
            let bin = (*value as usize * bins / 256).min(bins - 1);
            let cell = channel * plane_len + column * bins + bin;
            let count = &mut result.counts[cell];
            *count = count.saturating_add(1);
            result.peak = result.peak.max(*count);
        }
    }
    Ok(result)
}

pub fn compute_vectorscope(
    pixels: &[u8],
    width: usize,
    height: usize,
    size: usize,
) -> Result<Vectorscope, &'static str> {
    if size == 0 {
        return Err("vectorscope size must be positive");
    }
    validate_sample(pixels, width, height)?;
    let len = size
        .checked_mul(size)
        .ok_or("vectorscope dimensions overflow")?;
    let mut result = Vectorscope {
        counts: vec![0; len],
        size,
        peak: 0,
    };

    for pixel in pixels.chunks_exact(4) {
        let r = pixel[0] as f32 / 255.0;
        let g = pixel[1] as f32 / 255.0;
        let b = pixel[2] as f32 / 255.0;
        let y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
        // Rec.709 chroma coordinates, each nominally in [-0.5, 0.5].
        let cb = (b - y) / 1.8556;
        let cr = (r - y) / 1.5748;
        let x = ((cb + 0.5) * size as f32)
            .floor()
            .clamp(0.0, (size - 1) as f32) as usize;
        let y = ((0.5 - cr) * size as f32)
            .floor()
            .clamp(0.0, (size - 1) as f32) as usize;
        let count = &mut result.counts[y * size + x];
        *count = count.saturating_add(1);
        result.peak = result.peak.max(*count);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(rgb: [u8; 3], width: usize, height: usize) -> Vec<u8> {
        (0..width * height)
            .flat_map(|_| [rgb[0], rgb[1], rgb[2], 255])
            .collect()
    }

    #[test]
    fn gray_ramp_has_identical_parade_planes() {
        let pixels: Vec<u8> = (0..=255).flat_map(|v| [v, v, v, 255]).collect();
        let parade = compute_rgb_parade(&pixels, 256, 1, 16, 256).unwrap();
        let plane = parade.columns * parade.bins;
        assert_eq!(&parade.counts[..plane], &parade.counts[plane..2 * plane]);
        assert_eq!(&parade.counts[..plane], &parade.counts[2 * plane..]);
        assert_eq!(parade.peak, 1);
    }

    #[test]
    fn pure_red_lands_at_red_vectorscope_target() {
        let scope = compute_vectorscope(&solid([255, 0, 0], 4, 4), 4, 4, 256).unwrap();
        // Rec.709 red: Cb≈-0.1146, Cr=0.5 (the top edge).
        assert_eq!(scope.counts[98], 16);
        assert_eq!(scope.peak, 16);
        assert_eq!(scope.counts.iter().sum::<u32>(), 16);
    }

    #[test]
    fn neutral_gray_is_centered_and_black_is_also_neutral() {
        for rgb in [[128, 128, 128], [0, 0, 0]] {
            let scope = compute_vectorscope(&solid(rgb, 2, 2), 2, 2, 256).unwrap();
            assert_eq!(scope.counts[128 * 256 + 128], 4);
        }
    }

    #[test]
    fn validates_lengths_and_empty_frames() {
        assert!(compute_rgb_parade(&[0; 3], 1, 1, 8, 8).is_err());
        assert!(compute_vectorscope(&[], usize::MAX, 2, 8).is_err());
        assert_eq!(compute_rgb_parade(&[], 0, 0, 8, 8).unwrap().peak, 0);
        assert_eq!(compute_vectorscope(&[], 0, 0, 8).unwrap().peak, 0);
    }
}
