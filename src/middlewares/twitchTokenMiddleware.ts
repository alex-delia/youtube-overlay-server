import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

const MAX_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const EXPIRY_BUFFER = 60 * 1000; // 60 seconds in milliseconds
let cachedToken: TwitchTokenResponse | null = null;
let tokenExpiryTime: number | null = null;

interface TwitchTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export const twitchTokenMiddleware = createMiddleware<{
  Variables: {
    twitch: TwitchTokenResponse;
  };
}>(async (c, next) => {
  const currentTime = Date.now();

  if (
    cachedToken &&
    tokenExpiryTime &&
    currentTime < tokenExpiryTime - EXPIRY_BUFFER
  ) {
    c.set('twitch', cachedToken);
    await next();
    return;
  }

  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: process.env['TWITCH_CLIENT_ID']!,
      client_secret: process.env['TWITCH_CLIENT_SECRET']!,
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    throw new HTTPException(500, {
      message: `Failed to fetch Twitch token: ${response.statusText}`,
    });
  }

  const data = (await response.json()) as TwitchTokenResponse;

  const expiresInMs = Math.min(data.expires_in * 1000, MAX_CACHE_DURATION);
  cachedToken = data;
  tokenExpiryTime = Date.now() + expiresInMs - EXPIRY_BUFFER;

  // Set the token in the context variables
  c.set('twitch', {
    access_token: data.access_token,
    expires_in: data.expires_in,
    token_type: data.token_type,
  });

  await next();
});
