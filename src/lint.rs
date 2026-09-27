#[derive(Clone, Copy, Debug, PartialEq)]
enum Token<'a> {
    Name(&'a str),
    // None when the literal uses escapes or long brackets, whose text isn't decoded here.
    Text(Option<&'a str>),
    Symbol(u8),
    Other,
}

pub fn key_literals(source: &[u8]) -> Vec<(usize, &str)> {
    let tokens = tokens(source);
    let mut keys = Vec::new();
    for (i, &(offset, token)) in tokens.iter().enumerate() {
        if token == Token::Name("input")
            && !is_field(&tokens, i)
            && let [
                (_, Token::Symbol(b'.')),
                (_, Token::Name("held" | "pressed" | "released")),
                rest @ ..,
            ] = &tokens[i + 1..]
            && let Some(key) = literal_argument(rest)
        {
            let line = 1 + source[..offset].iter().filter(|&&b| b == b'\n').count();
            keys.push((line, key));
        }
    }
    keys
}

pub fn required_modules(source: &[u8]) -> Vec<&str> {
    let tokens = tokens(source);
    (0..tokens.len())
        .filter(|&i| tokens[i].1 == Token::Name("require") && !is_field(&tokens, i))
        .filter_map(|i| literal_argument(&tokens[i + 1..]))
        .collect()
}

fn is_field(tokens: &[(usize, Token)], i: usize) -> bool {
    i > 0 && matches!(tokens[i - 1].1, Token::Symbol(b'.' | b':'))
}

fn literal_argument<'a>(rest: &[(usize, Token<'a>)]) -> Option<&'a str> {
    match rest {
        [(_, Token::Text(text)), ..]
        | [
            (_, Token::Symbol(b'(')),
            (_, Token::Text(text)),
            (_, Token::Symbol(b')' | b',')),
            ..,
        ] => *text,
        _ => None,
    }
}

fn tokens(source: &[u8]) -> Vec<(usize, Token<'_>)> {
    let mut tokens = Vec::new();
    let mut i = 0;
    while let Some(&byte) = source.get(i) {
        let start = i;
        let token = match byte {
            b'-' if source.get(i + 1) == Some(&b'-') => {
                i = match long_bracket(source, i + 2) {
                    Some(level) => after_long_bracket(source, i + 2, level),
                    None => run_end(source, i, |b| b != b'\n'),
                };
                continue;
            }
            b'[' => match long_bracket(source, i) {
                Some(level) => {
                    i = after_long_bracket(source, i, level);
                    Token::Text(None)
                }
                None => {
                    i += 1;
                    Token::Symbol(byte)
                }
            },
            b'"' | b'\'' => {
                let mut end = i + 1;
                let mut escaped = false;
                while let Some(&b) = source.get(end) {
                    if b == byte {
                        break;
                    }
                    escaped |= b == b'\\';
                    end += if b == b'\\' { 2 } else { 1 };
                }
                i = (end + 1).min(source.len());
                let text = source.get(start + 1..end).filter(|_| !escaped);
                Token::Text(text.and_then(|text| std::str::from_utf8(text).ok()))
            }
            b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                i = run_end(source, i, |b| b.is_ascii_alphanumeric() || b == b'_');
                Token::Name(std::str::from_utf8(&source[start..i]).unwrap_or_default())
            }
            b'.' if source.get(i + 1) == Some(&b'.') => {
                i = run_end(source, i, |b| b == b'.');
                Token::Other
            }
            b'0'..=b'9' | b'.' if source[i..].iter().take(2).any(u8::is_ascii_digit) => {
                i = number_end(source, i);
                Token::Other
            }
            _ if byte.is_ascii_whitespace() => {
                i += 1;
                continue;
            }
            _ => {
                i += 1;
                Token::Symbol(byte)
            }
        };
        tokens.push((start, token));
    }
    tokens
}

fn run_end(source: &[u8], i: usize, keep: impl Fn(u8) -> bool) -> usize {
    source[i..]
        .iter()
        .position(|&b| !keep(b))
        .map_or(source.len(), |n| i + n)
}

fn number_end(source: &[u8], mut i: usize) -> usize {
    while let Some(&b) = source.get(i) {
        let exponent_sign =
            matches!(b, b'+' | b'-') && matches!(source[i - 1], b'e' | b'E' | b'p' | b'P');
        if !(b.is_ascii_alphanumeric() || b == b'.' || exponent_sign) {
            break;
        }
        i += 1;
    }
    i
}

fn long_bracket(source: &[u8], i: usize) -> Option<usize> {
    let rest = source.get(i..)?.strip_prefix(b"[")?;
    let level = rest.iter().take_while(|&&b| b == b'=').count();
    (rest.get(level) == Some(&b'[')).then_some(level)
}

fn after_long_bracket(source: &[u8], i: usize, level: usize) -> usize {
    let close = [b"]".as_slice(), &vec![b'='; level], b"]"].concat();
    let body = i + level + 2;
    source[body..]
        .windows(close.len())
        .position(|window| window == close)
        .map_or(source.len(), |at| body + at + close.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_arguments_are_found_only_in_code() {
        let source = br#"
if input.held("Esc") then end
local fire = input.pressed 'Tab2' or input.released("Space", 1)
-- input.held("Comment") and require("comment")
--[==[ input.held("Long comment")
]==] print("input.held('String')") x = [[input.held("Long string")]]
self.input.held("Field") M.require("field")
input.held("E" .. "sc") input.held("E\115c") input.held(key) require(name)
input.held
  ("Split")
local util, more = require("util"), require "more"
"#;
        assert_eq!(
            key_literals(source),
            [(2, "Esc"), (3, "Tab2"), (3, "Space"), (9, "Split")]
        );
        assert_eq!(required_modules(source), ["util", "more"]);
    }
}
