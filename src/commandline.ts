// What incur would refuse in a command line with codes of its own, found before incur reads it, so those fail as USAGE in ThreeJam's words. It mirrors how incur reads a command line, so a flag or command incur adds needs adding here.
import { quote } from './errors.ts'
import { NAME } from './package.ts'

// incur's global flags, which it reads wherever they stand; the valued ones take the next word when there is one.
const GLOBAL = new Set(['--full-output', '--llms', '--llms-full', '--mcp', '--help', '-h', '--update', '--incur-update-check', '--version', '--schema', '--json', '--token-count'])
const VALUED = new Set(['--format', '--filter-output', '--token-limit', '--token-offset'])
// With these, incur shows help, a manifest, or its version, serves MCP, or updates itself, and looks up no command.
const NO_COMMAND = new Set(['--help', '-h', '--llms', '--llms-full', '--mcp', '--update', '--incur-update-check', '--version'])

export const FORMATS = ['toon', 'json', 'yaml', 'md', 'jsonl'] as const

// ThreeJam's commands, then incur's own, with the subcommands or shells each of those takes.
const COMMANDS = ['new', 'check', 'sim', 'shot', 'run', 'export']
const BUILT_IN: ReadonlyMap<string, readonly string[]> = new Map([
  ['mcp', ['add', 'doctor']],
  ['skills', ['add', 'list']],
  ['skill', ['add', 'list']],
  ['completions', ['bash', 'fish', 'nushell', 'zsh']],
])
const LISTED = [...COMMANDS, 'mcp', 'skills', 'completions']
const SUBCOMMAND_ALIASES: ReadonlyMap<string, string> = new Map([['ls', 'list']])

// What mcp add's own flags take after them, as its help shows them.
const MCP_ADD_VALUES: ReadonlyMap<string, string> = new Map([
  ['--agent', "an agent's name, like --agent claude-code"],
  ['--command', 'the command agents will run, like --command "npx threejam --mcp"'],
  ['-c', 'the command agents will run, like -c "npx threejam --mcp"'],
])

// incur refuses a misspelled command, a subcommand or shell it lacks, and a bad value for one of its own flags itself, before any command runs, with codes of its own, so the command line is read first and they fail as USAGE, as every other mistake in one does.
export function commandLineRefusal(argv: readonly string[]): string | undefined {
  const words: string[] = []
  let looksUp = true
  for (let i = 0; i < argv.length; i++) {
    const [word, value] = [argv[i], argv[i + 1]]
    if (VALUED.has(word) && value) {
      const wrong = valueRefusal(word, value)
      if (wrong !== undefined) return wrong
      i++
    } else if (word === '--version' && value !== undefined && !value.startsWith('-')) words.push(word)
    else if (GLOBAL.has(word)) looksUp &&= !NO_COMMAND.has(word)
    else words.push(word)
  }
  const at = words[0] === NAME ? 1 : 0
  if (words[at] === 'mcp' && words[at + 1] === 'add') return mcpAddRefusal(words.slice(at + 2))
  return looksUp ? commandRefusal(words) : undefined
}

// incur takes any number for --token-limit and --token-offset, but not a word or nothing.
function valueRefusal(flag: string, value: string): string | undefined {
  if (flag === '--format') return FORMATS.some((format) => format === value) ? undefined : `--format: expected ${listed(FORMATS, 'or')}, got ${quote(value)}`
  if (flag === '--token-limit' || flag === '--token-offset') return Number.isFinite(Number(value)) && value.trim() !== '' ? undefined : `${flag}: expected a number, got ${quote(value)}`
  return undefined
}

// incur takes its own commands after the CLI's name too, but ThreeJam's only first.
function commandRefusal(words: readonly string[]): string | undefined {
  const at = words[0] === NAME && BUILT_IN.has(words[1]) ? 1 : 0
  const [command, next] = [words[at], words[at + 1]]
  if (command === undefined || COMMANDS.includes(command)) return undefined
  const takes = BUILT_IN.get(command)
  if (takes !== undefined) {
    if (next === undefined || takes.includes(SUBCOMMAND_ALIASES.get(next) ?? next)) return undefined
    if (command === 'completions') return `completions takes ${listed(takes, 'or')}, not ${quote(next)}`
    return unknown(command, next, takes)
  }
  if (VALUED.has(command)) return `${command} needs a value after it`
  if (command.startsWith('-')) return `threejam takes its command first, before ${quote(command)}; its commands are ${listed(LISTED, 'and')}`
  return unknown(NAME, command, LISTED)
}

// incur's mcp add reads its flags from the command line itself and skips any word it doesn't know, or a flag that lacks its value, so it could register ThreeJam with every agent it finds; it takes only what its help shows.
function mcpAddRefusal(rest: readonly string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--no-global') continue
    const needs = MCP_ADD_VALUES.get(rest[i])
    if (needs === undefined) return `mcp add takes --agent NAME, --command CMD or -c CMD, and --no-global, not ${quote(rest[i])}`
    const value = rest[i + 1]
    if (value === undefined || value === '' || value.startsWith('-')) return `${rest[i]} needs ${needs}`
    i++
  }
  return undefined
}

function unknown(owner: string, word: string, commands: readonly string[]): string {
  const best = meant(word, commands)
  return `${owner} has no command ${quote(word)}; ${best === undefined ? 'its' : `did you mean ${best}? Its`} commands are ${listed(commands, 'and')}`
}

function listed(items: readonly string[], last: 'and' | 'or'): string {
  return items.length < 3 ? items.join(` ${last} `) : `${items.slice(0, -1).join(', ')}, ${last} ${items.at(-1)}`
}

// The word a mistyped one most likely meant, as incur suggests one: one it begins, then one that holds it, then one a few letters off.
function meant(word: string, candidates: readonly string[]): string | undefined {
  const typed = word.toLowerCase()
  const within = typed.length <= 4 ? 2 : Math.floor(typed.length / 2)
  let best: string | undefined
  let bestScore = Infinity
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    const off = edits(typed, lower)
    const score = lower.startsWith(typed) && lower !== typed ? off : lower.includes(typed) ? 100 + off : off <= within ? 200 + off : Infinity
    if (score < bestScore) [best, bestScore] = [candidate, score]
  }
  return best
}

// How many letters must be added, removed, or changed to turn one word into the other.
function edits(from: string, to: string): number {
  let row = Array.from({ length: to.length + 1 }, (_, i) => i)
  for (let i = 1; i <= from.length; i++) {
    const next = [i]
    for (let j = 1; j <= to.length; j++) next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (from[i - 1] === to[j - 1] ? 0 : 1)))
    row = next
  }
  return row[to.length]
}
