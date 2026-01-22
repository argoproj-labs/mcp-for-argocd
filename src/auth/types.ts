export interface OIDCConfig {
  issuer: string;
  clientID: string;
  cliClientID?: string;
  scopes: string[];
  enablePKCEAuthentication: boolean;
}

export interface OIDCProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface TokenInfo {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  idToken?: string;
}

export interface StoredAuth {
  serverUrl: string;
  token: TokenInfo;
  oidcConfig: OIDCConfig;
  storedAt: number;
}

export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export interface AuthCallbackResult {
  code: string;
  state: string;
}
