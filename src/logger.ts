
export class Logger {
    constructor(
        private readonly verbose: boolean
    ) {
    }

    notimplemented(what: string) {
        process.stderr.write(`${what} is not implemented\n`)
    }

    info(text: string) {
        if (this.verbose) {
            process.stdout.write(`[${new Date().toISOString()}] ${text}\n`)
        }
    }

    error(err: Error) {
        if (err && err.message) {
            process.stderr.write(`${err.message}\n`)
        }
    }
}