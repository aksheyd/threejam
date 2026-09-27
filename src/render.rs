use std::fs::File;
use std::io::BufWriter;
use std::path::Path;
use std::rc::Rc;

use glam::Mat4;
use glow::HasContext;

use crate::camera::Camera;
use crate::mesh::Meshes;
use crate::shader::{COLOR_FRAG, COLOR_VERT, Shader};
use crate::world::Sprite;

pub struct Renderer {
    shader: Shader,
    meshes: Meshes,
}

impl Renderer {
    pub fn new(gl: &Rc<glow::Context>) -> Result<Renderer, String> {
        let shader = Shader::new(gl, COLOR_VERT, COLOR_FRAG)?;
        let meshes = Meshes::new(gl)?;
        unsafe {
            gl.enable(glow::BLEND);
            gl.blend_func_separate(
                glow::SRC_ALPHA,
                glow::ONE_MINUS_SRC_ALPHA,
                glow::ONE,
                glow::ONE_MINUS_SRC_ALPHA,
            );
        }
        Ok(Renderer { shader, meshes })
    }

    pub fn draw<'a>(
        &self,
        gl: &glow::Context,
        camera: &Camera,
        background: [f32; 3],
        sprites: impl IntoIterator<Item = &'a Sprite>,
        width: u32,
        height: u32,
    ) {
        let [r, g, b] = background;
        unsafe {
            gl.viewport(0, 0, width as i32, height as i32);
            gl.clear_color(r, g, b, 1.0);
            gl.clear(glow::COLOR_BUFFER_BIT);
        }
        let shader = self.shader.bind();
        shader.set_mat4("view", &camera.view());
        shader.set_mat4(
            "projection",
            &camera.projection(width as f32 / height as f32),
        );
        for sprite in sprites {
            let model = Mat4::from_translation(sprite.position.extend(0.0))
                * Mat4::from_scale(sprite.size.extend(1.0));
            shader.set_mat4("model", &model);
            shader.set_vec4("color", sprite.color);
            self.meshes.get(sprite.shape).draw();
        }
    }
}

pub fn capture(
    gl: &glow::Context,
    width: u32,
    height: u32,
    draw: impl FnOnce(),
) -> Result<Vec<u8>, String> {
    let (w, h) = (width as i32, height as i32);
    unsafe {
        let framebuffer = gl.create_framebuffer()?;
        let renderbuffer = match gl.create_renderbuffer() {
            Ok(renderbuffer) => renderbuffer,
            Err(err) => {
                gl.delete_framebuffer(framebuffer);
                return Err(err);
            }
        };
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(framebuffer));
        gl.bind_renderbuffer(glow::RENDERBUFFER, Some(renderbuffer));
        gl.renderbuffer_storage(glow::RENDERBUFFER, glow::RGBA8, w, h);
        gl.framebuffer_renderbuffer(
            glow::FRAMEBUFFER,
            glow::COLOR_ATTACHMENT0,
            glow::RENDERBUFFER,
            Some(renderbuffer),
        );
        let pixels = if gl.check_framebuffer_status(glow::FRAMEBUFFER) == glow::FRAMEBUFFER_COMPLETE
        {
            draw();
            let mut pixels = vec![0; width as usize * height as usize * 4];
            gl.read_pixels(
                0,
                0,
                w,
                h,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelPackData::Slice(Some(&mut pixels)),
            );
            Ok(pixels)
        } else {
            Err(format!(
                "could not make a {width}x{height} offscreen framebuffer"
            ))
        };
        gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        gl.delete_renderbuffer(renderbuffer);
        gl.delete_framebuffer(framebuffer);
        // OpenGL returns the bottom row first.
        let row = width as usize * 4;
        pixels.map(|pixels| pixels.chunks_exact(row).rev().flatten().copied().collect())
    }
}

pub fn save_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
    let encode = || -> Result<(), png::EncodingError> {
        let file = BufWriter::new(File::create(path)?);
        let mut encoder = png::Encoder::new(file, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(rgba)?;
        writer.finish()
    };
    encode().map_err(|err| format!("{}: {err}", path.display()))
}
