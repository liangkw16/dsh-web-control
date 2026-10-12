export const required: string[]
export const checks: string[]
export function validateReport(report: unknown, base?: string): Promise<string[]>
export function main(args?: string[]): Promise<number>

export function currentEvidenceProse(report: any, base?: string): Promise<Record<string, string>>
