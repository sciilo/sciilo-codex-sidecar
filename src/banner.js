/**
 * The start-up banner: the Sciilo mark and wordmark, drawn for a terminal.
 *
 * <p>The mark is the one from the application — three connected nodes, one on
 * the left reaching two on the right — so the command that runs on a developer's
 * machine and the page in their browser are recognisably the same product.</p>
 *
 * <p>Two things are deliberately conditional. Colour is dropped unless the
 * output is a terminal that wants it, because a banner is also written to log
 * files and journals, where escape codes are noise. The drawing itself is
 * dropped when the output is not a terminal at all: a piped `sciilo-sidecar`
 * should print a line one can read and grep, not five lines of blocks.</p>
 */

const SAGE = '\x1b[38;2;123;156;139m'

const BOLD = '\x1b[1m'

const RESET = '\x1b[0m'

// Three connected nodes: one on the left, two on the right.
const MARK = [
    '    ● ',
    '  ╱   ',
    '●     ',
    '  ╲   ',
    '    ● ',
]

const WORDMARK = [
    '██████ ██████ ██ ██ ██     ██████',
    '██     ██     ██ ██ ██     ██  ██',
    '██████ ██     ██ ██ ██     ██  ██',
    '    ██ ██     ██ ██ ██     ██  ██',
    '██████ ██████ ██ ██ ██████ ██████',
]

/**
 * @param subtitle what this sidecar is, shown under the wordmark
 * @param version  the package version, or an empty string
 * @param tty      whether the output is a terminal (drawing) or not (one line)
 * @param colour   whether escape codes may be used
 * @returns the banner, newline-terminated, ready to print
 */
export function banner(subtitle, {
    version = '',
    tty = Boolean(process.stdout.isTTY),
    colour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
} = {}) {

    const tail = [subtitle, version].filter(Boolean).join(' ')
    if (!tty) {
        return `Sciilo · ${tail}\n`
    }

    const paint = (code, text) => (colour ? `${code}${text}${RESET}` : text)
    const lines = MARK.map((mark, row) =>
        `  ${paint(SAGE, mark)}${paint(BOLD, WORDMARK[row])}`)
    lines.push('')
    lines.push(`  ${paint(SAGE, ' '.repeat(MARK[0].length))}${tail}`)
    lines.push('')
    return `${lines.join('\n')}\n`
}
