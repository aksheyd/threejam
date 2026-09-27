use std::collections::HashSet;

const NAMES: [&str; 47] = [
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "Q",
    "R",
    "S",
    "T",
    "U",
    "V",
    "W",
    "X",
    "Y",
    "Z",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "Space",
    "Enter",
    "Tab",
    "Backspace",
    "Shift",
    "Ctrl",
    "Alt",
    "Up",
    "Down",
    "Left",
    "Right",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Key(&'static str);

impl Key {
    pub fn from_name(name: &str) -> Option<Key> {
        NAMES
            .iter()
            .find(|known| known.eq_ignore_ascii_case(name))
            .map(|&known| Key(known))
    }

    pub fn name(self) -> &'static str {
        self.0
    }

    pub fn names() -> &'static [&'static str] {
        &NAMES
    }

    pub fn unknown_message(name: &str) -> String {
        format!("unknown key {name:?} (keys: {})", NAMES.join(", "))
    }
}

#[derive(Clone, Debug, Default)]
pub struct Input {
    held: HashSet<Key>,
    // Keys that went down or up since the last end_tick, even if they changed back since.
    pressed: HashSet<Key>,
    released: HashSet<Key>,
}

impl Input {
    pub fn set(&mut self, key: Key, down: bool) {
        if down {
            if self.held.insert(key) {
                self.pressed.insert(key);
            }
        } else if self.held.remove(&key) {
            self.released.insert(key);
        }
    }

    pub fn hold_only(&mut self, keys: &[Key]) {
        for name in NAMES {
            let key = Key(name);
            self.set(key, keys.contains(&key));
        }
    }

    pub fn release_all(&mut self) {
        self.released.extend(self.held.drain());
    }

    pub fn end_tick(&mut self) {
        self.pressed.clear();
        self.released.clear();
    }

    pub fn is_held(&self, key: Key) -> bool {
        self.held.contains(&key)
    }

    pub fn was_pressed(&self, key: Key) -> bool {
        self.pressed.contains(&key)
    }

    pub fn was_released(&self, key: Key) -> bool {
        self.released.contains(&key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_name_ignores_case_and_rejects_unknown_names() {
        assert_eq!(Key::from_name("up").map(Key::name), Some("Up"));
        assert_eq!(Key::from_name("d").map(Key::name), Some("D"));
        assert_eq!(Key::from_name("Escape"), None);
    }

    #[test]
    fn a_tap_between_ticks_counts_on_the_next_tick_only() {
        let space = Key::from_name("Space").unwrap();
        let state = |input: &Input| {
            (
                input.is_held(space),
                input.was_pressed(space),
                input.was_released(space),
            )
        };
        let mut input = Input::default();
        input.set(space, true);
        input.set(space, false);
        assert_eq!(state(&input), (false, true, true));
        input.end_tick();
        assert_eq!(state(&input), (false, false, false));
    }
}
