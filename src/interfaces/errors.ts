import { HTTPException } from 'hono/http-exception';

export class AuthenticationError extends HTTPException {
  constructor(message: string = 'Unauthorized') {
    super(401, { message });
  }
}

export class NotFoundError extends HTTPException {
  constructor(message: string) {
    super(404, { message });
  }
}
