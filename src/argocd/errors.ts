export class PathValidationError extends Error {
  public readonly fieldName: string;

  constructor(fieldName: string, message: string) {
    super(message);
    this.name = 'PathValidationError';
    this.fieldName = fieldName;
  }
}

export class ArgoCDApiError extends Error {
  public readonly status: number;
  public readonly argoCode?: number;
  public readonly details?: string;

  constructor(status: number, message: string, argoCode?: number, details?: string) {
    super(message);
    this.name = 'ArgoCDApiError';
    this.status = status;
    this.argoCode = argoCode;
    this.details = details;
  }
}
