import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as querystring from 'querystring';
import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { logger } from '../shared/log_service';

const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = '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';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UNIFIED_STATE_KEY = 'antigravityUnifiedStateSync.oauthToken';

interface OAuthTokenResponse {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
}

interface AntigravityAuthTokenInfo {
    accessToken: string;
    refreshToken: string;
    tokenType: string;
    expiry: { seconds: number; nanos: number };
    isGcpTos: boolean;
    [key: string]: unknown;
}

interface AntigravityAuthApi {
    setOAuthTokenInfo: (tokenInfo: AntigravityAuthTokenInfo) => Promise<void>;
    getOAuthTokenInfo?: () => Promise<Record<string, unknown> | undefined>;
}

type VSCodeWithAntigravityAuth = typeof vscode & {
    antigravityAuth?: AntigravityAuthApi;
};

export interface SeamlessSwitchAccount {
    email: string;
    refreshToken: string;
    tokenType?: string;
    isGcpTos?: boolean;
}

export interface SeamlessSwitchResult {
    success: boolean;
    error?: string;
}

interface BetterSqlite3Statement {
    run: (...params: unknown[]) => void;
}

interface BetterSqlite3Database {
    prepare: (sql: string) => BetterSqlite3Statement;
    close: () => void;
}

export class SeamlessSwitchService {
    private encodeVarint(value: number): Buffer {
        const bytes: number[] = [];
        let v = value >>> 0;
        while (v > 0x7f) {
            bytes.push((v & 0x7f) | 0x80);
            v >>>= 7;
        }
        bytes.push(v & 0x7f);
        return Buffer.from(bytes);
    }

    private encodeField(fieldNum: number, data: Buffer): Buffer {
        const tag = this.encodeVarint((fieldNum << 3) | 2);
        const len = this.encodeVarint(data.length);
        return Buffer.concat([tag, len, data]);
    }

    private encodeVarintField(fieldNum: number, value: number): Buffer {
        const tag = this.encodeVarint((fieldNum << 3) | 0);
        const val = this.encodeVarint(value);
        return Buffer.concat([tag, val]);
    }

    private buildOAuthTokenInfoProto(
        accessToken: string,
        tokenType: string,
        refreshToken: string,
        expirySeconds: number,
    ): Buffer {
        const parts: Buffer[] = [];
        parts.push(this.encodeField(1, Buffer.from(accessToken)));
        parts.push(this.encodeField(2, Buffer.from(tokenType)));
        parts.push(this.encodeField(3, Buffer.from(refreshToken)));
        const expiryMsg = this.encodeVarintField(1, expirySeconds);
        parts.push(this.encodeField(4, expiryMsg));
        return Buffer.concat(parts);
    }

    private buildUnifiedStateValue(
        accessToken: string,
        tokenType: string,
        refreshToken: string,
        expirySeconds: number,
    ): string {
        const oauthInfoProto = this.buildOAuthTokenInfoProto(accessToken, tokenType, refreshToken, expirySeconds);
        const oauthInfoB64 = oauthInfoProto.toString('base64');
        const inner2 = this.encodeField(1, Buffer.from(oauthInfoB64));
        const sentinel = Buffer.from('oauthTokenInfoSentinelKey');
        const inner1 = Buffer.concat([
            this.encodeField(1, sentinel),
            this.encodeField(2, inner2),
        ]);
        const outer = this.encodeField(1, inner1);
        return outer.toString('base64');
    }

    private getStateDbPath(): string {
        const homeDir = os.homedir();
        if (process.platform === 'win32') {
            const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
            return path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        }
        if (process.platform === 'darwin') {
            return path.join(homeDir, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        }
        return path.join(homeDir, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
    }

    private async writeToStateDb(
        accessToken: string,
        tokenType: string,
        refreshToken: string,
        expirySeconds: number,
    ): Promise<void> {
        const dbPath = this.getStateDbPath();
        if (!fs.existsSync(dbPath)) {
            logger.warn(`[SeamlessSwitch] state.vscdb not found, skip persistence: ${dbPath}`);
            return;
        }

        const newValue = this.buildUnifiedStateValue(accessToken, tokenType, refreshToken, expirySeconds);

        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const DatabaseCtor = require('better-sqlite3') as new (dbPath: string) => BetterSqlite3Database;
            const db = new DatabaseCtor(dbPath);
            try {
                const stmt = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
                stmt.run(UNIFIED_STATE_KEY, newValue);
            } finally {
                db.close();
            }
            logger.info('[SeamlessSwitch] Persisted token to state.vscdb via better-sqlite3');
            return;
        } catch {
            logger.warn('[SeamlessSwitch] better-sqlite3 unavailable, fallback to sqlite3 CLI');
        }

        try {
            const escapedValue = newValue.replace(/'/g, "''");
            const escapedKey = UNIFIED_STATE_KEY.replace(/'/g, "''");
            const sql = `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${escapedKey}', '${escapedValue}');`;
            execSync(`sqlite3 "${dbPath}" "${sql}"`, { timeout: 5000, windowsHide: true });
            logger.info('[SeamlessSwitch] Persisted token to state.vscdb via sqlite3 CLI');
            return;
        } catch {
            logger.warn('[SeamlessSwitch] sqlite3 CLI unavailable');
        }

        logger.warn('[SeamlessSwitch] Token injected in-memory only, persistence unavailable');
    }

    private async refreshAccessToken(refreshToken: string): Promise<{
        accessToken: string;
        expiresInSeconds: number;
    }> {
        const postData = querystring.stringify({
            client_id: ANTIGRAVITY_CLIENT_ID,
            client_secret: ANTIGRAVITY_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        });

        return new Promise((resolve, reject) => {
            const req = https.request(TOKEN_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                },
                timeout: 15000,
            }, (res) => {
                let body = '';
                res.on('data', (chunk: Buffer | string) => {
                    body += chunk.toString();
                });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body) as OAuthTokenResponse;
                        if (res.statusCode !== 200) {
                            if (parsed.error === 'invalid_grant' || (parsed.error_description || '').includes('invalid_grant')) {
                                reject(new Error('Refresh token invalid, please re-authorize this account.'));
                            } else {
                                reject(new Error(`Token refresh failed: HTTP ${res.statusCode}`));
                            }
                            return;
                        }
                        if (!parsed.access_token) {
                            reject(new Error('Google token response missing access_token.'));
                            return;
                        }
                        resolve({
                            accessToken: parsed.access_token,
                            expiresInSeconds: parsed.expires_in || 3600,
                        });
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        reject(new Error(`Failed to parse token response: ${message}`));
                    }
                });
            });
            req.on('error', (error: Error) => reject(new Error(`Token request failed: ${error.message}`)));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Token request timeout.'));
            });
            req.write(postData);
            req.end();
        });
    }

    async switchTo(account: SeamlessSwitchAccount): Promise<SeamlessSwitchResult> {
        try {
            const vsc = vscode as VSCodeWithAntigravityAuth;
            const authApi = vsc.antigravityAuth;

            if (!authApi || typeof authApi.setOAuthTokenInfo !== 'function') {
                return { success: false, error: 'Not running in Antigravity host environment.' };
            }

            if (!account.refreshToken) {
                return { success: false, error: 'Missing refresh token for this account.' };
            }

            logger.info(`[SeamlessSwitch] Refreshing access token for ${account.email}...`);
            const refreshed = await this.refreshAccessToken(account.refreshToken);
            const expirySeconds = Math.floor(Date.now() / 1000) + refreshed.expiresInSeconds;
            const tokenType = account.tokenType || 'Bearer';

            const tokenInfo: AntigravityAuthTokenInfo = {
                accessToken: refreshed.accessToken,
                refreshToken: account.refreshToken,
                tokenType,
                expiry: { seconds: expirySeconds, nanos: 0 },
                isGcpTos: account.isGcpTos || false,
            };

            if (typeof authApi.getOAuthTokenInfo === 'function') {
                const currentToken = await authApi.getOAuthTokenInfo();
                if (currentToken) {
                    const skipKeys = new Set([
                        'accessToken', 'refreshToken', 'tokenType', 'expiry', 'isGcpTos',
                        'access_token', 'refresh_token', 'token_type',
                    ]);
                    for (const key of Object.keys(currentToken)) {
                        if (!skipKeys.has(key) && !(key in tokenInfo)) {
                            tokenInfo[key] = currentToken[key];
                        }
                    }
                }
            }

            await authApi.setOAuthTokenInfo(tokenInfo);
            logger.info('[SeamlessSwitch] OAuth token injected successfully');

            try {
                await this.writeToStateDb(refreshed.accessToken, tokenType, account.refreshToken, expirySeconds);
            } catch (error) {
                logger.warn('[SeamlessSwitch] Failed to persist token into state.vscdb', error);
            }

            return { success: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: message };
        }
    }
}

export const seamlessSwitchService = new SeamlessSwitchService();
