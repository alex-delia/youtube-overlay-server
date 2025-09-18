import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { createAuthMiddleware, bearer } from 'better-auth/plugins';
import { polar, checkout, portal } from '@alexdelia/polar-betterauth';
import { Polar } from '@polar-sh/sdk';

import prisma from '../prismaClient';

const client = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
  server: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
});

export const auth = betterAuth({
  appName: 'Twitch Overlay',
  basePath: '/auth',
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  socialProviders: {
    twitch: {
      clientId: process.env.TWITCH_CLIENT_ID as string,
      clientSecret: process.env.TWITCH_CLIENT_SECRET as string,
    },
  },
  plugins: [
    bearer(),
    polar({
      client,
      createCustomerOnSignUp: true,
      use: [
        checkout({
          products: [
            {
              productId: process.env.MONTHLY_PRODUCT_ID as string, // ID of Product from Polar Dashboard
              slug: 'monthly', // Custom slug for easy reference in Checkout URL, e.g. /checkout/pro
            },
            {
              productId: process.env.YEARLY_PRODUCT_ID as string, // ID of Product from Polar Dashboard
              slug: 'yearly', // Custom slug for easy reference in Checkout URL, e.g. /checkout/pro
            },
            {
              productId: process.env.LIFETIME_PRODUCT_ID as string, // ID of Product from Polar Dashboard
              slug: 'lifetime', // Custom slug for easy reference in Checkout URL, e.g. /checkout/pro
            },
          ],
          successUrl: '/success?checkout_id={CHECKOUT_ID}',
          authenticatedUsersOnly: true,
        }),
        portal(),
      ],
    }),
  ],
  trustedOrigins: [
    'twitchoverlayapp://callback',
    'twitchoverlayapp://error',
    'http://localhost:5173',
    'https://www.overwolf.com*',
    'overwolf-extension://mgkhoiaggpkcfjamphcneeffdgifjgbhafllgdib',
    'twitchoverlayappnative://callback',
    'twitchoverlayappnative://error',
  ],
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path.startsWith('/callback')) {
        const location = ctx.context.responseHeaders?.get('location');

        if (ctx.context.newSession) {
          if (location === 'twitchoverlayappnative://callback') {
            throw ctx.redirect(
              `twitchoverlayappnative://callback?token=${ctx.context.newSession.session.token}`,
            );
          } else {
            throw ctx.redirect(
              `twitchoverlayapp://callback?token=${ctx.context.newSession.session.token}`,
            );
          }
        } else {
          if (location === 'twitchoverlayappnative://callback') {
            throw ctx.redirect(`twitchoverlayappnative://error`);
          } else {
            throw ctx.redirect(`twitchoverlayapp://error`);
          }
        }
      }
    }),
  },
});
