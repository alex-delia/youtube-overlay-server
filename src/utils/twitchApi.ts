import type { Streamer } from '../interfaces/streamer';
import prisma from '../prismaClient';
import { HTTPException } from 'hono/http-exception';

interface UserData {
  id: string;
  login: string;
  display_name: string;
  type: string;
  broadcaster_type: string;
  description: string;
  profile_image_url: string;
  offline_image_url: string;
  view_count: number;
  created_at: string;
}

interface StreamData {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  type: string;
  title: string;
  tags: string[];
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url: string;
  is_mature: boolean;
}

interface ChannelData {
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
  broadcaster_language: string;
  game_id: string;
  game_name: string;
  title: string;
  delay: number;
  tags: string[];
  content_classification_labels: string[];
  is_branded_content: boolean;
}

interface SearchData {
  broadcaster_language: string;
  broadcaster_login: string;
  display_name: string;
  game_id: string;
  game_name: string;
  id: string;
  is_live: boolean;
  tags: string[];
  thumbnail_url: string;
  title: string;
  started_at: string;
}

interface TwitchTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

// interface BadgeData {
//   set_id: string;
//   versions: {
//     id: string;
//     image_url_1x: string;
//     image_url_2x: string;
//     image_url_4x: string;
//     title: string;
//     description: string;
//     click_action: string;
//     click_url: string;
//   }[];
// }

export async function fetchUserData({
  loginName,
  accessToken,
}: {
  loginName: string;
  accessToken: string;
}) {
  const response = await fetch(
    `https://api.twitch.tv/helix/users?login=${loginName}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-ID': process.env.TWITCH_CLIENT_ID!,
      },
    },
  );

  if (!response.ok) {
    throw new HTTPException(500, {
      message: `Failed to fetch User Data for ${loginName}`,
    });
  }

  const { data } = (await response.json()) as {
    data: UserData[];
  };

  return data[0];
}

export async function fetchStreamData({
  userId,
  accessToken,
}: {
  userId: string;
  accessToken: string;
}) {
  const response = await fetch(
    `https://api.twitch.tv/helix/streams?user_id=${userId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-ID': process.env.TWITCH_CLIENT_ID!,
      },
    },
  );

  if (!response.ok) {
    throw new HTTPException(500, {
      message: `Failed to fetch Stream Data for ${userId}`,
    });
  }

  const { data } = (await response.json()) as {
    data: StreamData[];
  };

  return data[0];
}

export async function searchStreams({
  searchQuery,
  accessToken,
}: {
  searchQuery: string;
  accessToken: string;
}): Promise<Streamer[]> {
  const searchResponse = await fetch(
    `https://api.twitch.tv/helix/search/channels?live_only=true&first=10&query=${searchQuery}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-ID': process.env.TWITCH_CLIENT_ID!,
      },
    },
  );

  if (!searchResponse.ok) {
    throw new HTTPException(500, {
      message: 'Failed to fetch Streams',
    });
  }

  const { data: searchData } = (await searchResponse.json()) as {
    data: SearchData[];
  };

  const streamers: Streamer[] = await Promise.all(
    searchData.map(async (stream) => {
      const streamData = await fetchStreamData({
        userId: stream.id,
        accessToken,
      });

      return {
        channelId: stream.id,
        loginName: stream.broadcaster_login,
        displayName: stream.display_name,
        profileImageUrl: stream.thumbnail_url,
        gameName: stream.game_name,
        viewers: streamData?.viewer_count || 0,
        isLive: stream.is_live,
        title: streamData?.title || '',
      };
    }),
  );

  return streamers.sort((a, b) => b.viewers - a.viewers);
}

export async function fetchChannelData({
  userId,
  accessToken,
}: {
  userId: string;
  accessToken: string;
}) {
  const response = await fetch(
    `https://api.twitch.tv/helix/channels?broadcaster_id=${userId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-ID': process.env.TWITCH_CLIENT_ID!,
      },
    },
  );

  if (!response.ok) {
    throw new HTTPException(500, {
      message: `Failed to fetch Channel Data for ${userId}`,
    });
  }

  const { data } = (await response.json()) as {
    data: ChannelData[];
  };

  return data[0];
}

interface FollowedStreamsData {
  user_id: string;
  user_login: string;
  user_name: string;
  game_name: string;
  title: string;
  type: string;
  viewer_count: number;
}

export async function fetchFollowedStreams({
  accountId,
  userAccessToken,
}: {
  accountId: string;
  userAccessToken: string;
}) {
  const response = await fetch(
    `https://api.twitch.tv/helix/streams/followed?user_id=${accountId}`,
    {
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
        'Client-ID': process.env.TWITCH_CLIENT_ID!,
      },
    },
  );

  if (!response.ok) {
    // 401 response indicates invalid access token
    if (response.status === 401) {
      const account = await prisma.account.findFirst({
        where: {
          accountId: accountId,
          providerId: 'twitch',
        },
        select: {
          id: true,
          refreshToken: true,
        },
      });

      if (!account || !account.refreshToken) {
        throw new HTTPException(500, {
          message: 'Invalid access token, no refresh token found',
        });
      }

      // try to refresh access token
      const twitchData = await refreshAccessToken(account.refreshToken);

      if (!twitchData) {
        throw new HTTPException(500, {
          message: 'Failed to fetch followed channels, token refresh failed',
        });
      }

      await prisma.account.update({
        where: {
          id: account.id,
        },
        data: {
          accessToken: twitchData.access_token,
          refreshToken: twitchData.refresh_token,
          accessTokenExpiresAt: new Date(
            Date.now() + twitchData.expires_in * 1000,
          ),
        },
      });

      return await fetchFollowedStreams({
        accountId,
        userAccessToken: twitchData.access_token,
      });
    } else {
      throw new HTTPException(500, {
        message: `Failed to fetch Followed Channels for ${accountId}: ${response.status} ${response.statusText}`,
      });
    }
  }

  const { data: followedStreams } = (await response.json()) as {
    data: FollowedStreamsData[];
  };

  const followedStreamers: Streamer[] = await Promise.all(
    followedStreams.map(async (stream) => {
      const userData = await fetchUserData({
        loginName: stream.user_login,
        accessToken: userAccessToken,
      });

      return {
        channelId: stream.user_id,
        displayName: stream.user_name,
        loginName: stream.user_login,
        profileImageUrl: userData.profile_image_url,
        gameName: stream.game_name,
        viewers: stream.viewer_count,
        isLive: true,
        title: stream.title,
      };
    }),
  );

  return followedStreamers;
}

export async function refreshAccessToken(refreshToken: string) {
  const encodedRefreshToken = encodeURIComponent(refreshToken);

  const response = await fetch(`https://id.twitch.tv/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=refresh_token&refresh_token=${encodedRefreshToken}`,
  });

  if (!response.ok) {
    //400 response indicates invalid refresh token
    if (response.status === 400) {
      throw new HTTPException(400, { message: 'INVALID_TOKEN' });
    } else {
      throw new HTTPException(500, {
        message: `Failed to refresh Access Token: ${response.status} ${response.statusText}`,
      });
    }
  }

  const data = (await response.json()) as TwitchTokenResponse;
  return data;
}

// export async function subscribeToChat({
//   userId,
//   broadcasterId,
//   accessToken,
//   sessionId,
// }: {
//   userId: string;
//   broadcasterId: string;
//   accessToken: string;
//   sessionId: string;
// }) {
//   const response = await fetch(
//     `https://api.twitch.tv/helix/eventsub/subscriptions`,
//     {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         Authorization: `Bearer ${accessToken}`,
//         'Client-ID': process.env.TWITCH_CLIENT_ID!,
//       },
//       body: JSON.stringify({
//         type: 'channel.chat.message',
//         version: '1',
//         condition: {
//           broadcaster_user_id: broadcasterId,
//           user_id: userId,
//         },
//         transport: {
//           method: 'websocket',
//           session_id: sessionId,
//         },
//       }),
//     },
//   );

//   if (!response.ok) {
//     console.log('response', await response.json());
//     throw new HTTPException(500, {
//       message: `Failed to post EventSub Chat for ${broadcasterId}`,
//     });
//   }

//   return await response.json();
// }

// export async function fetchChannelBadges({
//   loginName,
//   accessToken,
// }: {
//   loginName: string;
//   accessToken: string;
// }) {
//   const broadcaster = await fetchUserData({
//     loginName,
//     accessToken,
//   });

//   const response = await fetch(
//     `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${broadcaster.id}`,
//     {
//       headers: {
//         Authorization: `Bearer ${accessToken}`,
//         'Client-ID': process.env.TWITCH_CLIENT_ID!,
//       },
//     },
//   );

//   if (!response.ok) {
//     throw new HTTPException(500, {
//       message: `Failed to fetch Channel Badges for ${broadcaster.login}`,
//     });
//   }

//   const { data } = (await response.json()) as {
//     data: BadgeData[];
//   };

//   return data;
// }

// export async function fetchGlobalBadges({
//   accessToken,
// }: {
//   accessToken: string;
// }) {
//   const response = await fetch(
//     `https://api.twitch.tv/helix/chat/badges/global`,
//     {
//       headers: {
//         Authorization: `Bearer ${accessToken}`,
//         'Client-ID': process.env.TWITCH_CLIENT_ID!,
//       },
//     },
//   );

//   if (!response.ok) {
//     throw new HTTPException(500, {
//       message: `Failed to fetch Global Badges`,
//     });
//   }

//   const { data } = (await response.json()) as {
//     data: BadgeData[];
//   };

//   return data;
// }
