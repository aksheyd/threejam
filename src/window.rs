use std::error::Error;
use std::num::NonZeroU32;
use std::path::Path;
use std::rc::Rc;
use std::time::Instant;

use glutin::config::ConfigTemplateBuilder;
use glutin::context::{
    ContextApi, ContextAttributesBuilder, GlProfile, NotCurrentGlContext, PossiblyCurrentContext,
    Version,
};
use glutin::display::{GetGlDisplay, GlDisplay};
use glutin::surface::{GlSurface, Surface, SwapInterval, WindowSurface};
use glutin_winit::{DisplayBuilder, GlWindow};
use raw_window_handle::HasWindowHandle;
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, KeyEvent, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{KeyCode, ModifiersState, PhysicalKey};
use winit::window::{Window, WindowAttributes, WindowId};

use crate::camera::Camera;
use crate::input::{Input, Key};
use crate::render::{Renderer, capture, save_png};
use crate::world::{DT, Sprite, World};

pub const WIDTH: u32 = 800;
pub const HEIGHT: u32 = 600;

const MAX_FRAME_TIME: f64 = 0.25;

// Fields drop in declaration order, and GPU objects must be deleted while the context is alive.
struct Gfx {
    renderer: Renderer,
    gl: Rc<glow::Context>,
    surface: Surface<WindowSurface>,
    context: PossiblyCurrentContext,
    window: Window,
}

impl Gfx {
    fn new(event_loop: &ActiveEventLoop, title: &str, visible: bool) -> Result<Gfx, String> {
        Gfx::open(event_loop, title, visible)
            .map_err(|err| format!("could not open an OpenGL 3.3 window: {err}"))
    }

    fn open(
        event_loop: &ActiveEventLoop,
        title: &str,
        visible: bool,
    ) -> Result<Gfx, Box<dyn Error>> {
        let attributes = WindowAttributes::default()
            .with_title(title)
            .with_inner_size(LogicalSize::new(WIDTH, HEIGHT))
            .with_resizable(false)
            .with_visible(visible);
        let (window, config) = DisplayBuilder::new()
            .with_window_attributes(Some(attributes))
            .build(event_loop, ConfigTemplateBuilder::new(), |mut configs| {
                configs.next().expect("glutin found no OpenGL config")
            })?;
        let window = window.ok_or("glutin did not create the window")?;
        let display = config.display();
        let context_attributes = ContextAttributesBuilder::new()
            .with_context_api(ContextApi::OpenGl(Some(Version::new(3, 3))))
            .with_profile(GlProfile::Core)
            .build(Some(window.window_handle()?.as_raw()));
        let surface_attributes = window.build_surface_attributes(Default::default())?;
        let surface = unsafe { display.create_window_surface(&config, &surface_attributes) }?;
        let context = unsafe { display.create_context(&config, &context_attributes) }?
            .make_current(&surface)?;
        surface.set_swap_interval(&context, SwapInterval::Wait(NonZeroU32::MIN))?;
        let gl = Rc::new(unsafe {
            glow::Context::from_loader_function_cstr(|symbol| display.get_proc_address(symbol))
        });
        let renderer = Renderer::new(&gl)?;
        Ok(Gfx {
            renderer,
            gl,
            surface,
            context,
            window,
        })
    }
}

pub fn run(world: World, title: &str, reload: impl FnMut(&mut World)) -> Result<(), String> {
    let mut game = Game {
        world,
        title,
        reload,
        input: Input::default(),
        modifiers: ModifiersState::empty(),
        lag: 0.0,
        last_frame: Instant::now(),
        occluded: false,
        result: Ok(()),
        gfx: None,
    };
    EventLoop::new()
        .and_then(|event_loop| event_loop.run_app(&mut game))
        .map_err(|err| err.to_string())?;
    game.result
}

struct Game<'a, R> {
    world: World,
    title: &'a str,
    reload: R,
    input: Input,
    modifiers: ModifiersState,
    lag: f64,
    last_frame: Instant,
    occluded: bool,
    result: Result<(), String>,
    gfx: Option<Gfx>,
}

impl<R: FnMut(&mut World)> ApplicationHandler for Game<'_, R> {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.gfx.is_some() {
            return;
        }
        match Gfx::new(event_loop, self.title, true) {
            Ok(gfx) => {
                gfx.window.request_redraw();
                self.gfx = Some(gfx);
                self.last_frame = Instant::now();
            }
            Err(message) => {
                self.result = Err(message);
                event_loop.exit();
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::ModifiersChanged(modifiers) => self.modifiers = modifiers.state(),
            WindowEvent::KeyboardInput {
                event:
                    KeyEvent {
                        physical_key: PhysicalKey::Code(code),
                        state,
                        repeat: false,
                        ..
                    },
                ..
            } => {
                let pressed = state == ElementState::Pressed;
                if pressed && code == KeyCode::Escape {
                    event_loop.exit();
                } else if pressed && reloads(code, self.modifiers) {
                    (self.reload)(&mut self.world);
                    self.input = Input::default();
                    // Loading takes time the new game shouldn't catch up on.
                    self.lag = 0.0;
                    self.last_frame = Instant::now();
                } else if let Some(key) = key_for(code) {
                    self.input.set(key, pressed);
                }
            }
            // On macOS, keys held when focus leaves the window never get a release event.
            WindowEvent::Focused(false) => self.input.release_all(),
            // Some systems stop blocking swap_buffers for a hidden window, so redrawing it would spin a core.
            WindowEvent::Occluded(occluded) => {
                self.occluded = occluded;
                if occluded {
                    self.input.release_all();
                } else if let Some(gfx) = &self.gfx {
                    self.last_frame = Instant::now();
                    gfx.window.request_redraw();
                }
            }
            WindowEvent::Resized(size) => {
                if let (Some(gfx), Some(width), Some(height)) = (
                    &self.gfx,
                    NonZeroU32::new(size.width),
                    NonZeroU32::new(size.height),
                ) {
                    gfx.surface.resize(&gfx.context, width, height);
                }
            }
            WindowEvent::RedrawRequested => {
                if let Err(message) = self.frame() {
                    self.result = Err(message);
                    event_loop.exit();
                }
            }
            _ => {}
        }
    }
}

impl<R> Game<'_, R> {
    fn frame(&mut self) -> Result<(), String> {
        let Some(gfx) = self.gfx.as_ref().filter(|_| !self.occluded) else {
            return Ok(());
        };
        let now = Instant::now();
        self.lag += (now - self.last_frame).as_secs_f64().min(MAX_FRAME_TIME);
        self.last_frame = now;
        while self.lag >= DT {
            self.world
                .tick(&self.input)
                .map_err(|err| err.to_string())?;
            self.input.end_tick();
            self.lag -= DT;
        }
        let size = gfx.window.inner_size();
        gfx.renderer.draw(
            &gfx.gl,
            &Camera::default(),
            self.world.background(),
            self.world.sprites(),
            size.width,
            size.height,
        );
        gfx.surface
            .swap_buffers(&gfx.context)
            .map_err(|err| err.to_string())?;
        gfx.window.request_redraw();
        Ok(())
    }
}

pub struct Frame {
    background: [f32; 3],
    sprites: Vec<Sprite>,
}

impl Frame {
    pub fn new(world: &World) -> Frame {
        Frame {
            background: world.background(),
            sprites: world.sprites().copied().collect(),
        }
    }
}

pub fn screenshot(frames: &[(Frame, &Path)], title: &str) -> Result<(), String> {
    let mut builder = EventLoop::builder();
    #[cfg(target_os = "macos")]
    {
        use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
        builder
            .with_activation_policy(ActivationPolicy::Accessory)
            .with_activate_ignoring_other_apps(false);
    }
    let mut shot = Shot {
        frames,
        title,
        result: Err("the event loop never opened a window".to_owned()),
    };
    builder
        .build()
        .and_then(|event_loop| event_loop.run_app(&mut shot))
        .map_err(|err| err.to_string())?;
    shot.result
}

struct Shot<'a> {
    frames: &'a [(Frame, &'a Path)],
    title: &'a str,
    result: Result<(), String>,
}

impl ApplicationHandler for Shot<'_> {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.result = self.save(event_loop);
        event_loop.exit();
    }

    fn window_event(&mut self, _: &ActiveEventLoop, _: WindowId, _: WindowEvent) {}
}

impl Shot<'_> {
    fn save(&self, event_loop: &ActiveEventLoop) -> Result<(), String> {
        let gfx = Gfx::new(event_loop, self.title, false)?;
        for (frame, path) in self.frames {
            let rgba = capture(&gfx.gl, WIDTH, HEIGHT, || {
                gfx.renderer.draw(
                    &gfx.gl,
                    &Camera::default(),
                    frame.background,
                    &frame.sprites,
                    WIDTH,
                    HEIGHT,
                );
            })?;
            save_png(path, WIDTH, HEIGHT, &rgba)?;
        }
        Ok(())
    }
}

fn reloads(code: KeyCode, modifiers: ModifiersState) -> bool {
    code == KeyCode::F5
        || (cfg!(target_os = "macos") && code == KeyCode::KeyR && modifiers.super_key())
}

fn key_for(code: KeyCode) -> Option<Key> {
    let name = match code {
        KeyCode::KeyA => "A",
        KeyCode::KeyB => "B",
        KeyCode::KeyC => "C",
        KeyCode::KeyD => "D",
        KeyCode::KeyE => "E",
        KeyCode::KeyF => "F",
        KeyCode::KeyG => "G",
        KeyCode::KeyH => "H",
        KeyCode::KeyI => "I",
        KeyCode::KeyJ => "J",
        KeyCode::KeyK => "K",
        KeyCode::KeyL => "L",
        KeyCode::KeyM => "M",
        KeyCode::KeyN => "N",
        KeyCode::KeyO => "O",
        KeyCode::KeyP => "P",
        KeyCode::KeyQ => "Q",
        KeyCode::KeyR => "R",
        KeyCode::KeyS => "S",
        KeyCode::KeyT => "T",
        KeyCode::KeyU => "U",
        KeyCode::KeyV => "V",
        KeyCode::KeyW => "W",
        KeyCode::KeyX => "X",
        KeyCode::KeyY => "Y",
        KeyCode::KeyZ => "Z",
        KeyCode::Digit0 => "0",
        KeyCode::Digit1 => "1",
        KeyCode::Digit2 => "2",
        KeyCode::Digit3 => "3",
        KeyCode::Digit4 => "4",
        KeyCode::Digit5 => "5",
        KeyCode::Digit6 => "6",
        KeyCode::Digit7 => "7",
        KeyCode::Digit8 => "8",
        KeyCode::Digit9 => "9",
        KeyCode::Space => "Space",
        KeyCode::Enter => "Enter",
        KeyCode::Tab => "Tab",
        KeyCode::Backspace => "Backspace",
        KeyCode::ShiftLeft | KeyCode::ShiftRight => "Shift",
        KeyCode::ControlLeft | KeyCode::ControlRight => "Ctrl",
        KeyCode::AltLeft | KeyCode::AltRight => "Alt",
        KeyCode::ArrowUp => "Up",
        KeyCode::ArrowDown => "Down",
        KeyCode::ArrowLeft => "Left",
        KeyCode::ArrowRight => "Right",
        _ => return None,
    };
    Key::from_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_keys_map_to_script_key_names() {
        let cases = [
            (KeyCode::KeyA, Some("A")),
            (KeyCode::KeyZ, Some("Z")),
            (KeyCode::Digit0, Some("0")),
            (KeyCode::Digit9, Some("9")),
            (KeyCode::Space, Some("Space")),
            (KeyCode::ShiftRight, Some("Shift")),
            (KeyCode::ControlLeft, Some("Ctrl")),
            (KeyCode::AltRight, Some("Alt")),
            (KeyCode::ArrowLeft, Some("Left")),
            (KeyCode::Escape, None),
            (KeyCode::Numpad1, None),
        ];
        for (code, name) in cases {
            assert_eq!(key_for(code).map(Key::name), name, "{code:?}");
        }
    }

    #[test]
    fn f5_reloads_everywhere_and_cmd_r_on_macos_but_r_stays_a_script_key() {
        let none = ModifiersState::empty();
        assert!(reloads(KeyCode::F5, none));
        assert_eq!(
            reloads(KeyCode::KeyR, ModifiersState::SUPER),
            cfg!(target_os = "macos")
        );
        assert!(!reloads(KeyCode::KeyR, none));
        assert!(!reloads(KeyCode::KeyR, ModifiersState::CONTROL));
    }
}
