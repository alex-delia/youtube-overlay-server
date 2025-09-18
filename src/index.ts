import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { twitchTokenMiddleware } from './middlewares/twitchTokenMiddleware';
import { HTTPException } from 'hono/http-exception';
import { rateLimiter, type Store } from 'hono-rate-limiter';
import { logger } from 'hono/logger';
import { RedisStore } from 'rate-limit-redis';
import { createClient } from 'redis';

import { NotFoundError } from './interfaces/errors';

import {
  fetchChannelData,
  fetchFollowedStreams,
  fetchStreamData,
  fetchUserData,
  searchStreams,
  // subscribeToChat,
  // fetchChannelBadges,
  // fetchGlobalBadges,
} from './utils/twitchApi';

import { auth } from './utils/auth';
import { authMiddleware } from './middlewares/authMiddleware';

import prisma from './prismaClient';
import type { Streamer } from './interfaces/streamer';

const app = new Hono<{
  Variables: {
    user: typeof auth.$Infer.Session.user | null;
    session: typeof auth.$Infer.Session.session | null;
  };
}>();

const allowedOrigins = [
  'twitchoverlayapp://',
  'http://localhost:5173',
  'https://www.overwolf.com',
  'overwolf-extension://',
  'twitchoverlayappnative://',
] as const;

const redisClient = await createClient({
  url: process.env.REDIS_URL,
})
  .on('error', (err) => console.log('Redis Client Error', err))
  .connect();

app.use(
  cors({
    origin: (origin) => {
      if (!origin) return null;
      return allowedOrigins.some((o) => origin.startsWith(o)) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'x-client-id',
      'x-platform',
      'location',
    ],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
    credentials: true,
  }),
);

app.use(
  rateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 1000, // Limit each IP to 500 requests per `window`
    standardHeaders: true,
    skip: (c) => c.req.path.startsWith('/auth/callback'),
    keyGenerator: async (c) => {
      const session = await auth.api.getSession({
        headers: c.req.raw.headers as Headers,
      });

      // If authenticated, use user ID as the key
      if (session?.user?.id) {
        return `user-${session.user.id}`;
      }

      const clientId = c.req.header('x-client-id');
      if (clientId) {
        return `client-${clientId}`;
      }

      const ip =
        c.req.header('x-forwarded-for') ||
        c.req.header('x-real-ip') ||
        'unknown';
      return `ip-${ip}`;
    },
    store: new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
    }) as unknown as Store,
  }),
);

app.use('*', async (c, next) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers as Headers,
  });

  if (!session) {
    c.set('user', null);
    c.set('session', null);
    return next();
  }

  c.set('user', session.user);
  c.set('session', session.session);
  return next();
});

if (process.env.NODE_ENV !== 'production') {
  console.log('Development mode');
  app.use(logger());
}

app.on(['POST', 'GET'], '/auth/*', (c) => {
  return auth.handler(c.req.raw);
});

app.get('/success', (c) => {
  const platform = c.req.query('platform');

  if (platform === 'native') {
    return c.redirect(`twitchoverlayappnative://paymentSuccess`);
  }

  if (platform === 'electron') {
    return c.redirect('twitchoverlayapp://paymentSuccess');
  }

  return c.json({ message: 'Platform not found' }, 400);
});

// Get followed channels
app.get('/channels/followed', authMiddleware, async (c) => {
  const user = c.var.user;

  const twitchAccount = await prisma.account.findFirst({
    where: {
      userId: user.id,
      providerId: 'twitch',
    },
    select: {
      accountId: true,
      accessToken: true,
    },
  });

  if (
    !twitchAccount ||
    !twitchAccount.accessToken ||
    !twitchAccount.accountId
  ) {
    throw new NotFoundError('User Twitch account not found');
  }

  const followedStreams = await fetchFollowedStreams({
    accountId: twitchAccount.accountId,
    userAccessToken: twitchAccount.accessToken,
  });

  return c.json({
    followedStreams,
  });
});

// Get a channel by name
app.get('/channels/:name', twitchTokenMiddleware, async (c) => {
  const name = c.req.param('name');
  const twitch = c.get('twitch');

  const userData = await fetchUserData({
    loginName: name,
    accessToken: twitch.access_token,
  });

  if (!userData) {
    throw new NotFoundError('Channel not found');
  }

  const broadcasterId = userData.id;
  const streamData = await fetchStreamData({
    userId: broadcasterId,
    accessToken: twitch.access_token,
  });

  if (streamData) {
    const streamer: Streamer = {
      channelId: userData.id,
      displayName: userData.display_name,
      loginName: userData.login,
      profileImageUrl: userData.profile_image_url,
      gameName: streamData.game_name,
      viewers: streamData.viewer_count,
      isLive: streamData.type === 'live',
      title: streamData.title,
    };
    return c.json({
      streamer,
    });
  }

  const channelData = await fetchChannelData({
    userId: broadcasterId,
    accessToken: twitch.access_token,
  });

  if (!channelData) {
    throw new NotFoundError('Channel not found');
  }

  const streamer: Streamer = {
    channelId: userData.id,
    displayName: userData.display_name,
    loginName: userData.login,
    profileImageUrl: userData.profile_image_url,
    gameName: channelData.game_name,
    title: channelData.title,
    viewers: 0,
    isLive: false,
  };

  return c.json({
    streamer,
  });
});

// Get streams by name
app.get('/streams/:name', twitchTokenMiddleware, async (c) => {
  const name = c.req.param('name');
  const twitch = c.get('twitch');

  const streamers = await searchStreams({
    searchQuery: name,
    accessToken: twitch.access_token,
  });

  return c.json({
    streamers,
  });
});

// app.get('/channels/:name/badges', twitchTokenMiddleware, async (c) => {
//   const name = c.req.param('name');
//   const twitch = c.get('twitch');

//   const [badges, globalBadges] = await Promise.all([
//     fetchChannelBadges({
//       loginName: name,
//       accessToken: twitch.access_token,
//     }),
//     fetchGlobalBadges({
//       accessToken: twitch.access_token,
//     }),
//   ]);

//   return c.json({
//     badges,
//     globalBadges,
//   });
// });

// app.post('/eventsub/chat', authMiddleware, async (c) => {
//   const user = c.var.user;

//   const body = await c.req.json();

//   const { broadcaster_name, session_id } = body.data;

//   const userTwitchAccount = await prisma.account.findFirst({
//     where: {
//       userId: user.id,
//       providerId: 'twitch',
//     },
//     select: {
//       accountId: true,
//       accessToken: true,
//     },
//   });

//   if (!userTwitchAccount || !userTwitchAccount.accessToken) {
//     throw new NotFoundError('User Twitch account not found');
//   }

//   const broadcaster = await fetchUserData({
//     loginName: broadcaster_name,
//     accessToken: userTwitchAccount.accessToken,
//   });

//   if (!broadcaster) {
//     throw new NotFoundError('Broadcaster not found');
//   }

//   await subscribeToChat({
//     userId: userTwitchAccount.accountId,
//     broadcasterId: broadcaster.id,
//     accessToken: userTwitchAccount.accessToken,
//     sessionId: session_id,
//   });

//   return c.json({
//     message: 'Event Sub received',
//   });
// });

app.notFound((c) => {
  return c.json({ error: 'Route Not Found' }, 404);
});

app.onError((err, c) => {
  console.error(`[${new Date().toISOString()}] ${err}`);

  if (err instanceof HTTPException) {
    return c.json(
      {
        message: err.message,
      },
      err.status,
    );
  }

  return c.json(
    {
      message: 'An unexpected error occurred',
    },
    500,
  );
});

export default {
  port: process.env.PORT || 3000,
  fetch: app.fetch,
};
