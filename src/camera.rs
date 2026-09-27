use glam::camera::rh::{proj, view};
use glam::{Mat4, Vec3};

pub const HALF_HEIGHT: f32 = 1.5;

#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub position: Vec3,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            position: Vec3::new(0.0, 0.0, 3.0),
        }
    }
}

impl Camera {
    pub fn view(&self) -> Mat4 {
        view::look_at_mat4(self.position, self.position + Vec3::NEG_Z, Vec3::Y)
    }

    pub fn projection(&self, aspect: f32) -> Mat4 {
        let half_width = HALF_HEIGHT * aspect;
        proj::opengl::orthographic(
            -half_width,
            half_width,
            -HALF_HEIGHT,
            HALF_HEIGHT,
            0.1,
            100.0,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::{Vec2, Vec4};

    #[test]
    fn a_four_by_three_view_is_centered_and_reaches_2_by_1_5() {
        let camera = Camera::default();
        let clip = camera.projection(4.0 / 3.0) * camera.view();
        let ndc = |x, y| {
            let point = clip * Vec4::new(x, y, 0.0, 1.0);
            Vec2::new(point.x, point.y) / point.w
        };
        assert!(
            ndc(2.0, 1.5).abs_diff_eq(Vec2::ONE, 1e-6),
            "{}",
            ndc(2.0, 1.5)
        );
        assert!(
            ndc(0.0, 0.0).abs_diff_eq(Vec2::ZERO, 1e-6),
            "{}",
            ndc(0.0, 0.0)
        );
    }
}
