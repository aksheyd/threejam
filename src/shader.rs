use std::rc::Rc;

use glam::{Mat4, Vec4};
use glow::HasContext;

pub const COLOR_VERT: &str = "#version 330 core
layout(location = 0) in vec3 aPos;
uniform mat4 model;
uniform mat4 view;
uniform mat4 projection;
void main() {
    gl_Position = projection * view * model * vec4(aPos, 1.0);
}
";

pub const COLOR_FRAG: &str = "#version 330 core
out vec4 FragColor;
uniform vec4 color;
void main() {
    FragColor = color;
}
";

pub struct Shader {
    gl: Rc<glow::Context>,
    program: glow::NativeProgram,
}

pub struct BoundShader<'a> {
    shader: &'a Shader,
}

impl Shader {
    pub fn new(gl: &Rc<glow::Context>, vertex: &str, fragment: &str) -> Result<Self, String> {
        unsafe {
            let program = gl.create_program().map_err(|e| e.to_string())?;
            let vs = match compile(gl, glow::VERTEX_SHADER, vertex) {
                Ok(shader) => shader,
                Err(err) => {
                    gl.delete_program(program);
                    return Err(err);
                }
            };
            let fs = match compile(gl, glow::FRAGMENT_SHADER, fragment) {
                Ok(shader) => shader,
                Err(err) => {
                    gl.delete_shader(vs);
                    gl.delete_program(program);
                    return Err(err);
                }
            };
            gl.attach_shader(program, vs);
            gl.attach_shader(program, fs);
            gl.link_program(program);
            gl.detach_shader(program, vs);
            gl.detach_shader(program, fs);
            gl.delete_shader(vs);
            gl.delete_shader(fs);
            if !gl.get_program_link_status(program) {
                let log = gl.get_program_info_log(program);
                gl.delete_program(program);
                return Err(log);
            }
            Ok(Self {
                gl: Rc::clone(gl),
                program,
            })
        }
    }

    /// Bind this program. Uniform setters live on the returned guard.
    pub fn bind(&self) -> BoundShader<'_> {
        unsafe { self.gl.use_program(Some(self.program)) };
        BoundShader { shader: self }
    }
}

impl Drop for Shader {
    fn drop(&mut self) {
        unsafe { self.gl.delete_program(self.program) };
    }
}

impl BoundShader<'_> {
    pub fn set_mat4(&self, name: &str, value: &Mat4) {
        unsafe {
            self.shader.gl.uniform_matrix_4_f32_slice(
                self.location(name).as_ref(),
                false,
                &value.to_cols_array(),
            );
        }
    }

    pub fn set_vec4(&self, name: &str, value: Vec4) {
        unsafe {
            self.shader.gl.uniform_4_f32(
                self.location(name).as_ref(),
                value.x,
                value.y,
                value.z,
                value.w,
            );
        }
    }

    fn location(&self, name: &str) -> Option<glow::NativeUniformLocation> {
        unsafe {
            self.shader
                .gl
                .get_uniform_location(self.shader.program, name)
        }
    }
}

fn compile(gl: &glow::Context, kind: u32, source: &str) -> Result<glow::NativeShader, String> {
    unsafe {
        let shader = gl.create_shader(kind).map_err(|e| e.to_string())?;
        gl.shader_source(shader, source);
        gl.compile_shader(shader);
        if gl.get_shader_compile_status(shader) {
            Ok(shader)
        } else {
            let log = gl.get_shader_info_log(shader);
            gl.delete_shader(shader);
            Err(log)
        }
    }
}
