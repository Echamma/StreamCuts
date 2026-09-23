use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::{hash_map::DefaultHasher, VecDeque};
use std::hash::{Hash, Hasher};

use bytemuck::{Pod, Zeroable};
use color_grade::{ColorGradeParams, Wheel};
use gpu::{GpuContext, FULLSCREEN_SHADER_SOURCE};
use thiserror::Error;
use wgpu::util::DeviceExt;

use crate::{EffectPass, UniformValue};

const GAUSSIAN_BLUR_SHADER_ID: &str = "gaussian-blur";
const GAUSSIAN_BLUR_SHADER_SOURCE: &str = include_str!("shaders/gaussian_blur.wgsl");
const COLOR_WHEELS_SHADER_ID: &str = "color-wheels";
const COLOR_WHEELS_SHADER_SOURCE: &str = include_str!("shaders/color_wheels.wgsl");
const LUT_3D_SHADER_ID: &str = "lut-3d";
const LUT_3D_SHADER_SOURCE: &str = include_str!("shaders/lut_3d.wgsl");
const TONE_CURVES_SHADER_ID: &str = "tone-curves";
const TONE_CURVES_SHADER_SOURCE: &str = include_str!("shaders/tone_curves.wgsl");

/// Uniform names carrying the LUT table for {@link LUT_3D_SHADER_ID}: the
/// per-axis node count, and the flat RGB triples the `.cube` parser produced
/// (`size^3 * 3` values, red-fastest).
const LUT_SIZE_UNIFORM: &str = "lutSize";
const LUT_TABLE_UNIFORM: &str = "lutTable";

pub struct ApplyEffectsOptions<'a> {
    pub source: &'a wgpu::Texture,
    pub width: u32,
    pub height: u32,
    pub passes: &'a [EffectPass],
}

pub struct EffectPipeline {
    uniform_bind_group_layout: wgpu::BindGroupLayout,
    /// Layout for the LUT pass's extra bind group (group 2): the 3D table plus
    /// its filtering sampler. Only `lut-3d` binds it.
    lut_bind_group_layout: wgpu::BindGroupLayout,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
    // Shared by playback/export passes; bounded to eight 3D textures.
    lut_cache: RefCell<VecDeque<CachedLut>>,
}

struct CachedLut {
    key: u64,
    bind_group: wgpu::BindGroup,
    output_range: LutOutputRange,
}

#[derive(Clone, Copy, Debug)]
struct LutOutputRange {
    min: [f32; 3],
    max: [f32; 3],
}

impl Default for LutOutputRange {
    fn default() -> Self {
        // Keep the usual [0, 1] LUT at full 8-bit precision, while expanding
        // only channels with nodes outside that range.
        Self {
            min: [0.; 3],
            max: [1.; 3],
        }
    }
}

impl LutOutputRange {
    fn include(&mut self, channel: usize, value: f32) {
        self.min[channel] = self.min[channel].min(value);
        self.max[channel] = self.max[channel].max(value);
    }

    fn encode(&self, channel: usize, value: f32) -> u8 {
        let normalized = (value - self.min[channel]) / (self.max[channel] - self.min[channel]);
        (normalized.clamp(0., 1.) * 255.).round() as u8
    }
}

#[derive(Debug, Error)]
pub enum EffectsError {
    #[error("At least one effect pass is required")]
    MissingEffectPasses,
    #[error("Unknown effect shader '{shader}'")]
    UnknownEffectShader { shader: String },
    #[error("Missing uniform '{uniform}' for shader '{shader}'")]
    MissingUniform { shader: String, uniform: String },
    #[error("Uniform '{uniform}' for shader '{shader}' must be a number")]
    InvalidNumberUniform { shader: String, uniform: String },
    #[error(
        "Uniform '{uniform}' for shader '{shader}' must be a vector of length {expected_length}"
    )]
    InvalidVectorUniform {
        shader: String,
        uniform: String,
        expected_length: usize,
    },
    #[error("Shader '{shader}' does not support uniform '{uniform}'")]
    UnsupportedUniform { shader: String, uniform: String },
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct EffectUniformBuffer {
    resolution: [f32; 2],
    direction: [f32; 2],
    scalars: [f32; 4],
}

impl EffectPipeline {
    pub fn new(context: &GpuContext) -> Self {
        let uniform_bind_group_layout =
            context
                .device()
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("effects-uniform-bind-group-layout"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    }],
                });
        let vertex_shader_module =
            context
                .device()
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("effects-fullscreen-shader"),
                    source: wgpu::ShaderSource::Wgsl(FULLSCREEN_SHADER_SOURCE.into()),
                });
        let pipeline_layout =
            context
                .device()
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("effects-pipeline-layout"),
                    bind_group_layouts: &[
                        Some(context.texture_sampler_bind_group_layout()),
                        Some(&uniform_bind_group_layout),
                    ],
                    immediate_size: 0,
                });

        // The LUT pass needs a third bind group for the 3D table, so it gets its
        // own layout rather than forcing every other effect to declare a group
        // it never binds.
        let lut_bind_group_layout =
            context
                .device()
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("effects-lut-bind-group-layout"),
                    entries: &[
                        wgpu::BindGroupLayoutEntry {
                            binding: 0,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D3,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 1,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                            count: None,
                        },
                    ],
                });
        let lut_pipeline_layout =
            context
                .device()
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("effects-lut-pipeline-layout"),
                    bind_group_layouts: &[
                        Some(context.texture_sampler_bind_group_layout()),
                        Some(&uniform_bind_group_layout),
                        Some(&lut_bind_group_layout),
                    ],
                    immediate_size: 0,
                });

        // Every effect shares the fullscreen vertex shader and differs only in
        // its fragment module (and, for the LUT, its layout), so build them from
        // one helper.
        let build_pipeline_with =
            |label: &str, fragment_source: &str, layout: &wgpu::PipelineLayout| {
                let fragment_module =
                    context
                        .device()
                        .create_shader_module(wgpu::ShaderModuleDescriptor {
                            label: Some(label),
                            source: wgpu::ShaderSource::Wgsl(fragment_source.into()),
                        });
                context
                    .device()
                    .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                        label: Some(label),
                        layout: Some(layout),
                        vertex: wgpu::VertexState {
                            module: &vertex_shader_module,
                            entry_point: Some("vertex_main"),
                            buffers: &[wgpu::VertexBufferLayout {
                                array_stride: std::mem::size_of::<[f32; 2]>() as u64,
                                step_mode: wgpu::VertexStepMode::Vertex,
                                attributes: &[wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x2,
                                    offset: 0,
                                    shader_location: 0,
                                }],
                            }],
                            compilation_options: wgpu::PipelineCompilationOptions::default(),
                        },
                        fragment: Some(wgpu::FragmentState {
                            module: &fragment_module,
                            entry_point: Some("fragment_main"),
                            targets: &[Some(wgpu::ColorTargetState {
                                format: context.texture_format(),
                                blend: None,
                                write_mask: wgpu::ColorWrites::ALL,
                            })],
                            compilation_options: wgpu::PipelineCompilationOptions::default(),
                        }),
                        primitive: wgpu::PrimitiveState::default(),
                        depth_stencil: None,
                        multisample: wgpu::MultisampleState::default(),
                        multiview_mask: None,
                        cache: None,
                    })
            };

        let pipelines = HashMap::from([
            (
                GAUSSIAN_BLUR_SHADER_ID.to_string(),
                build_pipeline_with(
                    "effects-gaussian-blur-pipeline",
                    GAUSSIAN_BLUR_SHADER_SOURCE,
                    &pipeline_layout,
                ),
            ),
            (
                COLOR_WHEELS_SHADER_ID.to_string(),
                build_pipeline_with(
                    "effects-color-wheels-pipeline",
                    COLOR_WHEELS_SHADER_SOURCE,
                    &pipeline_layout,
                ),
            ),
            (
                LUT_3D_SHADER_ID.to_string(),
                build_pipeline_with(
                    "effects-lut-3d-pipeline",
                    LUT_3D_SHADER_SOURCE,
                    &lut_pipeline_layout,
                ),
            ),
            (
                TONE_CURVES_SHADER_ID.to_string(),
                build_pipeline_with(
                    "effects-tone-curves-pipeline",
                    TONE_CURVES_SHADER_SOURCE,
                    &pipeline_layout,
                ),
            ),
        ]);

        Self {
            uniform_bind_group_layout,
            lut_bind_group_layout,
            pipelines,
            lut_cache: RefCell::new(VecDeque::new()),
        }
    }

    pub fn apply(
        &self,
        context: &GpuContext,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut encoder =
            context
                .device()
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("effects-command-encoder"),
                });
        let output = self.apply_with_encoder(
            context,
            &mut encoder,
            ApplyEffectsOptions {
                source,
                width,
                height,
                passes,
            },
        )?;
        context.queue().submit([encoder.finish()]);
        Ok(output)
    }

    pub fn apply_with_encoder(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut current_texture: Option<wgpu::Texture> = None;

        for pass in passes {
            let input_texture = current_texture.as_ref().unwrap_or(source);
            let output_texture =
                context.create_render_texture(width, height, "effects-pass-output");
            let input_view = input_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let texture_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-texture-bind-group"),
                        layout: context.texture_sampler_bind_group_layout(),
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&input_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                            },
                        ],
                    });
            // The LUT texture carries values normalized to a per-channel output
            // range. Bind it first so the same range can be sent to the shader.
            let lut = if pass.shader == LUT_3D_SHADER_ID {
                Some(self.create_lut_bind_group(context, pass)?)
            } else {
                None
            };
            let uniform_bytes =
                pack_effect_uniforms(pass, width, height, lut.as_ref().map(|(_, range)| *range))?;
            let uniform_buffer =
                context
                    .device()
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("effects-uniform-buffer"),
                        contents: &uniform_bytes,
                        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    });
            let uniform_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-uniform-bind-group"),
                        layout: &self.uniform_bind_group_layout,
                        entries: &[wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform_buffer.as_entire_binding(),
                        }],
                    });
            let pipeline = self.pipelines.get(&pass.shader).ok_or_else(|| {
                EffectsError::UnknownEffectShader {
                    shader: pass.shader.clone(),
                }
            })?;

            {
                let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("effects-render-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &output_view,
                        resolve_target: None,
                        depth_slice: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    occlusion_query_set: None,
                    timestamp_writes: None,
                    multiview_mask: None,
                });
                render_pass.set_pipeline(pipeline);
                render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
                render_pass.set_bind_group(0, &texture_bind_group, &[]);
                render_pass.set_bind_group(1, &uniform_bind_group, &[]);
                if let Some((lut_bind_group, _)) = lut.as_ref() {
                    render_pass.set_bind_group(2, lut_bind_group, &[]);
                }
                render_pass.draw(0..6, 0..1);
            }

            current_texture = Some(output_texture);
        }

        current_texture.ok_or(EffectsError::MissingEffectPasses)
    }

    /// Upload a pass's `.cube` table as a 3D texture and bind it with a
    /// filtering sampler, so `textureSample` interpolates between LUT nodes in
    /// hardware (see `shaders/lut_3d.wgsl`).
    ///
    /// The table arrives as flat RGB triples, red-fastest — the layout the
    /// `.cube` parser emits — and is expanded to RGBA8 because 8-bit unorm is
    /// filterable on every WebGPU backend, whereas 32-bit float filtering needs
    /// an optional feature. That matches the compositor's own 8-bit surfaces.
    fn create_lut_bind_group(
        &self,
        context: &GpuContext,
        pass: &EffectPass,
    ) -> Result<(wgpu::BindGroup, LutOutputRange), EffectsError> {
        let raw_size = read_number_uniform(pass, LUT_SIZE_UNIFORM)?;
        let size = raw_size as u32;
        let table = read_vector_uniform(pass, LUT_TABLE_UNIFORM)?;

        let expected_len = (size as usize)
            .checked_pow(3)
            .and_then(|nodes| nodes.checked_mul(3))
            .unwrap_or(0);
        if !(2..=65).contains(&size) || raw_size != size as f32 || table.len() != expected_len {
            return Err(EffectsError::InvalidVectorUniform {
                shader: pass.shader.clone(),
                uniform: LUT_TABLE_UNIFORM.to_string(),
                expected_length: expected_len,
            });
        }

        let mut hasher = DefaultHasher::new();
        size.hash(&mut hasher);
        let mut output_range = LutOutputRange::default();
        for triple in table.chunks_exact(3) {
            for (channel, &value) in triple.iter().enumerate() {
                if !value.is_finite() {
                    return Err(EffectsError::InvalidVectorUniform {
                        shader: pass.shader.clone(),
                        uniform: LUT_TABLE_UNIFORM.to_string(),
                        expected_length: expected_len,
                    });
                }
                value.to_bits().hash(&mut hasher);
                output_range.include(channel, value);
            }
        }
        if (0..3)
            .any(|channel| !(output_range.max[channel] - output_range.min[channel]).is_finite())
        {
            return Err(EffectsError::InvalidVectorUniform {
                shader: pass.shader.clone(),
                uniform: LUT_TABLE_UNIFORM.to_string(),
                expected_length: expected_len,
            });
        }
        let key = hasher.finish();
        let mut cache = self.lut_cache.borrow_mut();
        if let Some(index) = cache.iter().position(|entry| entry.key == key) {
            let entry = cache.remove(index).unwrap();
            let group = entry.bind_group.clone();
            let output_range = entry.output_range;
            cache.push_back(entry);
            return Ok((group, output_range));
        }

        // RGB triples -> RGBA8, alpha opaque.
        let mut texels = Vec::with_capacity(table.len() / 3 * 4);
        for triple in table.chunks_exact(3) {
            for (channel, &value) in triple.iter().enumerate() {
                texels.push(output_range.encode(channel, value));
            }
            texels.push(u8::MAX);
        }

        let extent = wgpu::Extent3d {
            width: size,
            height: size,
            depth_or_array_layers: size,
        };
        let texture = context.device().create_texture(&wgpu::TextureDescriptor {
            label: Some("effects-lut-3d-texture"),
            size: extent,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        context.queue().write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &texels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(size * 4),
                rows_per_image: Some(size),
            },
            extent,
        );

        let view = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D3),
            ..Default::default()
        });
        let group = context
            .device()
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("effects-lut-bind-group"),
                layout: &self.lut_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                    },
                ],
            });
        if cache.len() >= 8 {
            cache.pop_front();
        }
        cache.push_back(CachedLut {
            key,
            bind_group: group.clone(),
            output_range,
        });
        Ok((group, output_range))
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Lut3dUniformBuffer {
    // intensity, size, _, _
    scalars: [f32; 4],
    domain_min: [f32; 4],
    domain_max: [f32; 4],
    output_min: [f32; 4],
    output_max: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ColorWheelsUniformBuffer {
    lanes: [[f32; 4]; 6],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ToneCurvesUniformBuffer {
    counts: [f32; 4],
    nodes: [[f32; 4]; 128],
}

/// Pack the uniform bytes for a pass, dispatching on its shader. Different
/// shaders declare different uniform structs; the shared uniform binding accepts
/// any buffer size, so each shader gets exactly the bytes its struct expects.
fn pack_effect_uniforms(
    pass: &EffectPass,
    width: u32,
    height: u32,
    lut_output_range: Option<LutOutputRange>,
) -> Result<Vec<u8>, EffectsError> {
    match pass.shader.as_str() {
        GAUSSIAN_BLUR_SHADER_ID => {
            Ok(bytemuck::bytes_of(&pack_blur_uniforms(pass, width, height)?).to_vec())
        }
        COLOR_WHEELS_SHADER_ID => {
            Ok(bytemuck::bytes_of(&pack_color_wheels_uniforms(pass)?).to_vec())
        }
        LUT_3D_SHADER_ID => Ok(bytemuck::bytes_of(&pack_lut_3d_uniforms(
            pass,
            lut_output_range.expect("LUT output range must accompany the LUT texture"),
        )?)
        .to_vec()),
        TONE_CURVES_SHADER_ID => Ok(bytemuck::bytes_of(&pack_tone_curves_uniforms(pass)?).to_vec()),
        other => Err(EffectsError::UnknownEffectShader {
            shader: other.to_string(),
        }),
    }
}

fn pack_blur_uniforms(
    pass: &EffectPass,
    width: u32,
    height: u32,
) -> Result<EffectUniformBuffer, EffectsError> {
    let shader = pass.shader.as_str();
    let sigma = read_number_uniform(pass, "u_sigma")?;
    let step = read_number_uniform(pass, "u_step")?;
    let direction = read_vec2_uniform(pass, "u_direction")?;

    for uniform in pass.uniforms.keys() {
        if uniform == "u_sigma" || uniform == "u_step" || uniform == "u_direction" {
            continue;
        }
        return Err(EffectsError::UnsupportedUniform {
            shader: shader.to_string(),
            uniform: uniform.clone(),
        });
    }

    Ok(EffectUniformBuffer {
        resolution: [width as f32, height as f32],
        direction,
        scalars: [sigma, step, 0.0, 0.0],
    })
}

fn pack_color_wheels_uniforms(pass: &EffectPass) -> Result<ColorWheelsUniformBuffer, EffectsError> {
    let wheel = |prefix: &str| -> Result<Wheel, EffectsError> {
        Ok(Wheel {
            rgb: read_vec3_uniform(pass, &format!("u_{prefix}"))?,
            master: read_number_uniform(pass, &format!("u_{prefix}_master"))?,
        })
    };

    let params = ColorGradeParams {
        lift: wheel("lift")?,
        gamma: wheel("gamma")?,
        gain: wheel("gain")?,
        offset: wheel("offset")?,
        contrast: read_number_uniform(pass, "u_contrast")?,
        pivot: read_number_uniform(pass, "u_pivot")?,
        saturation: read_number_uniform(pass, "u_saturation")?,
        temperature: read_number_uniform(pass, "u_temperature")?,
        tint: read_number_uniform(pass, "u_tint")?,
        hue: read_number_uniform(pass, "u_hue")?,
    };

    Ok(ColorWheelsUniformBuffer {
        lanes: params.gpu_uniforms(),
    })
}

fn pack_tone_curves_uniforms(pass: &EffectPass) -> Result<ToneCurvesUniformBuffer, EffectsError> {
    let raw_counts = read_vector_uniform(pass, "curveCounts")?;
    if raw_counts.len() != 4
        || raw_counts
            .iter()
            .any(|&n| !n.is_finite() || !(2.0..=32.0).contains(&n) || n.fract() != 0.0)
    {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: "curveCounts".into(),
            expected_length: 4,
        });
    }
    let raw_nodes = read_vector_uniform(pass, "curveNodes")?;
    if raw_nodes.len() != 512 || raw_nodes.iter().any(|n| !n.is_finite()) {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: "curveNodes".into(),
            expected_length: 512,
        });
    }
    let mut nodes = [[0.; 4]; 128];
    for (node, values) in nodes.iter_mut().zip(raw_nodes.chunks_exact(4)) {
        node.copy_from_slice(values);
    }
    let mut counts = [0.; 4];
    counts.copy_from_slice(raw_counts);
    Ok(ToneCurvesUniformBuffer { counts, nodes })
}

/// The LUT table is bound as a texture. Its output range restores values outside
/// [0, 1] after filtering and before intensity is blended with the source.
fn pack_lut_3d_uniforms(
    pass: &EffectPass,
    output_range: LutOutputRange,
) -> Result<Lut3dUniformBuffer, EffectsError> {
    let intensity = match pass.uniforms.get("intensity") {
        Some(UniformValue::Number(value)) => *value,
        Some(UniformValue::Vector(_)) => {
            return Err(EffectsError::InvalidNumberUniform {
                shader: pass.shader.clone(),
                uniform: "intensity".to_string(),
            });
        }
        None => 1.0,
    };
    let size = read_number_uniform(pass, LUT_SIZE_UNIFORM)?;
    let min = if pass.uniforms.contains_key("domainMin") {
        read_vec3_uniform(pass, "domainMin")?
    } else {
        [0.; 3]
    };
    let max = if pass.uniforms.contains_key("domainMax") {
        read_vec3_uniform(pass, "domainMax")?
    } else {
        [1.; 3]
    };
    Ok(Lut3dUniformBuffer {
        scalars: [intensity, size, 0.0, 0.0],
        domain_min: [min[0], min[1], min[2], 0.],
        domain_max: [max[0], max[1], max[2], 0.],
        output_min: [
            output_range.min[0],
            output_range.min[1],
            output_range.min[2],
            0.,
        ],
        output_max: [
            output_range.max[0],
            output_range.max[1],
            output_range.max[2],
            0.,
        ],
    })
}

/// Borrow a vector uniform's values without asserting a length — callers that
/// know the expected length check it themselves (the LUT table's length depends
/// on its node count).
fn read_vector_uniform<'a>(pass: &'a EffectPass, uniform: &str) -> Result<&'a [f32], EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    match value {
        UniformValue::Vector(values) => Ok(values),
        UniformValue::Number(_) => Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 0,
        }),
    }
}

fn read_number_uniform(pass: &EffectPass, uniform: &str) -> Result<f32, EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    match value {
        UniformValue::Number(value) => Ok(*value),
        UniformValue::Vector(_) => Err(EffectsError::InvalidNumberUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        }),
    }
}

fn read_vec2_uniform(pass: &EffectPass, uniform: &str) -> Result<[f32; 2], EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    let UniformValue::Vector(values) = value else {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        });
    };
    if values.len() != 2 {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        });
    }
    Ok([values[0], values[1]])
}

fn read_vec3_uniform(pass: &EffectPass, uniform: &str) -> Result<[f32; 3], EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    let UniformValue::Vector(values) = value else {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 3,
        });
    };
    if values.len() != 3 {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 3,
        });
    }
    Ok([values[0], values[1], values[2]])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lut_output_range_survives_partial_intensity_blending() {
        let mut range = LutOutputRange::default();
        range.include(0, 1.5);
        range.include(1, -0.5);
        let pass = EffectPass {
            shader: LUT_3D_SHADER_ID.to_string(),
            uniforms: HashMap::from([
                ("lutSize".to_string(), UniformValue::Number(2.)),
                ("intensity".to_string(), UniformValue::Number(0.5)),
            ]),
        };
        let uniform = pack_lut_3d_uniforms(&pass, range).unwrap();
        assert_eq!(&uniform.output_min[..3], &[0., -0.5, 0.]);
        assert_eq!(&uniform.output_max[..3], &[1.5, 1., 1.]);

        // A 1.5 LUT node used to be clipped to 1.0 during upload, so a 50%
        // blend with a 0.5 source incorrectly became 0.75 instead of 1.0.
        let encoded = range.encode(0, 1.5);
        let decoded = uniform.output_min[0]
            + encoded as f32 / 255. * (uniform.output_max[0] - uniform.output_min[0]);
        let blended = 0.5 + (decoded - 0.5) * uniform.scalars[0];
        assert!((blended - 1.).abs() < 1e-6);
        assert_eq!(range.encode(1, -0.5), 0);
        assert_eq!(LutOutputRange::default().encode(0, 0.5), 128);
    }
}
