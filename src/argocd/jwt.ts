export type JwtPayload = {
  exp?: number;
  iss?: string;
  aud?: string | string[];
  sub?: string;
  email?: string;
  groups?: string[];
};

export const decodeJwtPayload = (token: string): JwtPayload | undefined => {
  try {
    const payload = token.split('.')[1];
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as JwtPayload;
  } catch {
    return undefined;
  }
};
