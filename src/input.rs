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
}

#[derive(Clone, Debug, Default)]
pub struct Input {
    held: HashSet<Key>,
}

impl Input {
    pub fn set(&mut self, key: Key, down: bool) {
        if down {
            self.held.insert(key);
        } else {
            self.held.remove(&key);
        }
    }

    pub fn is_held(&self, key: Key) -> bool {
        self.held.contains(&key)
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
}
