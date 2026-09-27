use std::rc::Rc;

use glow::HasContext;

use crate::game::Shape;

pub struct Mesh {
    gl: Rc<glow::Context>,
    vao: glow::NativeVertexArray,
    vbo: glow::NativeBuffer,
    ebo: glow::NativeBuffer,
    index_count: i32,
}

pub struct Meshes {
    pub square: Mesh,
    pub triangle: Mesh,
}

impl Meshes {
    pub fn new(gl: &Rc<glow::Context>) -> Result<Self, String> {
        Ok(Self {
            square: Mesh::square(gl)?,
            triangle: Mesh::triangle(gl)?,
        })
    }

    pub fn get(&self, shape: Shape) -> &Mesh {
        match shape {
            Shape::Square => &self.square,
            Shape::Triangle => &self.triangle,
        }
    }
}

impl Mesh {
    pub fn square(gl: &Rc<glow::Context>) -> Result<Self, String> {
        Self::indexed(
            gl,
            &[
                0.5, 0.5, 0.0, // top right
                0.5, -0.5, 0.0, // bottom right
                -0.5, -0.5, 0.0, // bottom left
                -0.5, 0.5, 0.0, // top left
            ],
            &[0, 1, 3, 1, 2, 3],
        )
    }

    pub fn triangle(gl: &Rc<glow::Context>) -> Result<Self, String> {
        Self::indexed(
            gl,
            &[
                -0.5, -0.5, 0.0, // left
                0.5, -0.5, 0.0, // right
                0.0, 0.5, 0.0, // top
            ],
            &[0, 1, 2],
        )
    }

    fn indexed(gl: &Rc<glow::Context>, positions: &[f32], indices: &[u32]) -> Result<Self, String> {
        unsafe {
            let vao = gl.create_vertex_array().map_err(|e| e.to_string())?;
            let vbo = gl.create_buffer().map_err(|e| e.to_string())?;
            let ebo = gl.create_buffer().map_err(|e| e.to_string())?;
            gl.bind_vertex_array(Some(vao));
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(vbo));
            gl.buffer_data_u8_slice(
                glow::ARRAY_BUFFER,
                bytemuck::cast_slice(positions),
                glow::STATIC_DRAW,
            );
            gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, Some(ebo));
            gl.buffer_data_u8_slice(
                glow::ELEMENT_ARRAY_BUFFER,
                bytemuck::cast_slice(indices),
                glow::STATIC_DRAW,
            );
            gl.vertex_attrib_pointer_f32(0, 3, glow::FLOAT, false, 12, 0);
            gl.enable_vertex_attrib_array(0);
            gl.bind_vertex_array(None);
            Ok(Self {
                gl: Rc::clone(gl),
                vao,
                vbo,
                ebo,
                index_count: indices.len() as i32,
            })
        }
    }

    pub fn draw(&self) {
        unsafe {
            self.gl.bind_vertex_array(Some(self.vao));
            self.gl
                .draw_elements(glow::TRIANGLES, self.index_count, glow::UNSIGNED_INT, 0);
        }
    }
}

impl Drop for Mesh {
    fn drop(&mut self) {
        unsafe {
            self.gl.delete_vertex_array(self.vao);
            self.gl.delete_buffer(self.vbo);
            self.gl.delete_buffer(self.ebo);
        }
    }
}
