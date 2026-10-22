// A-012: PureNet errors are assumed to be RFC 9457 problem+json.
export class PureNetError extends Error {
  constructor(status, problem = {}, { operation } = {}) {
    super(`PureNet ${operation ?? 'request'} failed: ${status} ${problem.title ?? ''}${problem.detail ? ` (${problem.detail})` : ''}`.trim());
    this.name = 'PureNetError';
    this.status = status;
    this.problem = problem;
  }
}
