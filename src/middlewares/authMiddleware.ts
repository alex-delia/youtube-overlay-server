import { createMiddleware } from 'hono/factory';
import { auth } from '../utils/auth';
import { AuthenticationError } from '../interfaces/errors';
export const authMiddleware = createMiddleware<{
  Variables: {
    user: typeof auth.$Infer.Session.user;
  };
}>(async (c, next) => {
  const user = c.get('user');

  if (!user) throw new AuthenticationError();

  c.set('user', user);

  await next();
});
