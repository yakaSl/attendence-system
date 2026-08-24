export class IngestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "IngestError";
    this.status = status;
    this.code = code;
  }
}

export function errorBody(error: IngestError): {
  error: { code: string; message: string };
} {
  return {
    error: {
      code: error.code,
      message: error.message,
    },
  };
}
