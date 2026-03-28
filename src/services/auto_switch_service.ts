/**
 * Antigravity Cockpit - 自动切号服务
 * 当监控模型的额度低于阈值时，自动切换到有额度的账号
 *
 * 工作流程：
 * 1. 开启自动切号后，启动监控定时器
 * 2. 根据额度动态调整刷新间隔（额度越低刷新越快）
 * 3. 检查当前账号的监控模型是否低于阈值
 * 4. 如果低于阈值，顺序探测下一个账号的额度
 * 5. 找到有额度的账号后自动切换，继续监控
 */

import * as vscode from 'vscode';
import { logger } from '../shared/log_service';
import { configService } from '../shared/config_service';
import { credentialStorage } from '../auto_trigger/credential_storage';
import type { AccountsRefreshService, AccountQuotaCache } from './accountsRefreshService';

/** 自动切号配置 */
export interface AutoSwitchConfig {
    /** 是否启用自动切号 */
    enabled: boolean;
    /** 触发阈值（百分比）：0 / 20 / 40 */
    threshold: number;
    /** 监控的模型 ID 列表（空 = 监控所有模型） */
    monitoredModels: string[];
}

/** 监控定时器 */
let monitorTimer: ReturnType<typeof setTimeout> | null = null;

/** 防重入标志 */
let autoSwitchInProgress = false;

/** 上次自动切号时间（避免频繁切换） */
let lastAutoSwitchAt = 0;
const AUTO_SWITCH_COOLDOWN_MS = 30_000; // 30 秒冷却期

/** accountsService 引用，由 startMonitoring 设置 */
let serviceRef: AccountsRefreshService | null = null;

/** 切号完成后的回调（由 extension 注册，负责刷新 reactor/状态栏） */
let onSwitchedCallback: (() => void) | null = null;

/**
 * 注册切号完成后的回调
 * 由 extension.ts 调用，传入 reactor.tryUseQuotaCache + syncTelemetry 逻辑
 */
export function setOnSwitchedCallback(cb: () => void): void {
    onSwitchedCallback = cb;
}

/**
 * 获取自动切号配置
 */
export function getAutoSwitchConfig(): AutoSwitchConfig {
    return {
        enabled: configService.getStateValue<boolean>('autoSwitchEnabled', false) ?? false,
        threshold: configService.getStateValue<number>('autoSwitchThreshold', 0) ?? 0,
        monitoredModels: configService.getStateValue<string[]>('autoSwitchMonitoredModels', []) ?? [],
    };
}

/**
 * 保存自动切号配置
 */
export async function saveAutoSwitchConfig(config: AutoSwitchConfig): Promise<void> {
    await configService.setStateValue('autoSwitchEnabled', config.enabled);
    await configService.setStateValue('autoSwitchThreshold', config.threshold);
    await configService.setStateValue('autoSwitchMonitoredModels', config.monitoredModels);
    logger.info(`[AutoSwitch] Config saved: enabled=${config.enabled}, threshold=${config.threshold}%, models=${config.monitoredModels.length || 'all'}`);

    // 重启监控（配置变化）
    if (serviceRef) {
        if (config.enabled) {
            startMonitoring(serviceRef);
        } else {
            stopMonitoring();
        }
    }
}

/**
 * 启动监控定时器
 */
export function startMonitoring(accountsService: AccountsRefreshService): void {
    serviceRef = accountsService;
    stopMonitoring(); // 先清除旧定时器

    const config = getAutoSwitchConfig();
    if (!config.enabled) {
        logger.info('[AutoSwitch] Monitoring not started (disabled)');
        return;
    }

    logger.info(`[AutoSwitch] Starting dynamic monitoring, threshold: ${config.threshold}%`);

    // 立即执行第一次，之后动态调度
    void runMonitorCycleAndReschedule(accountsService);
}

/**
 * 停止监控定时器
 */
export function stopMonitoring(): void {
    if (monitorTimer) {
        clearTimeout(monitorTimer);
        monitorTimer = null;
        logger.info('[AutoSwitch] Monitoring timer stopped');
    }
}

/**
 * 根据当前额度百分比计算刷新间隔
 * API 只返回 5 个档位：100% / 80% / 60% / 40% / 20% / 0%
 * 20% 是耗尽前的最后一档，需要极高频轮询
 *
 * - > 60%: 3 分钟
 * - ≤ 60%: 2 分钟
 * - ≤ 40%: 30 秒
 * - ≤ 20%: 3 秒（最后一档，随时可能跳到 0%）
 */
function getRefreshIntervalMs(lowestPct: number): number {
    if (lowestPct <= 20) {
        return 3_000;      // 3秒！最后一档，随时可能耗尽
    } else if (lowestPct <= 40) {
        return 30_000;     // 30秒
    } else if (lowestPct <= 60) {
        return 120_000;    // 2分钟
    } else {
        return 180_000;    // 3分钟
    }
}

/**
 * 获取当前账号监控模型的最低额度百分比
 */
function getLowestMonitoredPct(accountsService: AccountsRefreshService, monitoredModels: string[]): number {
    const currentEmail = accountsService.getCurrentEmail();
    if (!currentEmail) {
        return 100;
    }
    const cache = accountsService.getQuotaCache(currentEmail);
    if (!cache?.snapshot?.models) {
        return 100;
    }
    const allModels = (cache.snapshot as { allModels?: typeof cache.snapshot.models }).allModels ?? cache.snapshot.models;
    let lowest = 100;
    for (const model of allModels) {
        if (monitoredModels.length > 0) {
            const isMonitored = monitoredModels.some(
                m => m.toLowerCase() === (model.modelId ?? model.label ?? '').toLowerCase(),
            );
            if (!isMonitored) {
                continue;
            }
        }
        const pct = model.remainingPercentage ?? 100;
        if (pct < lowest) {
            lowest = pct;
        }
    }
    return lowest;
}

/**
 * 执行一次监控循环，然后根据额度动态调度下一次
 */
async function runMonitorCycleAndReschedule(accountsService: AccountsRefreshService): Promise<void> {
    const config = getAutoSwitchConfig();
    if (!config.enabled) {
        return;
    }

    await runMonitorCycle(accountsService);

    // 计算动态间隔
    const lowestPct = getLowestMonitoredPct(accountsService, config.monitoredModels);
    const intervalMs = getRefreshIntervalMs(lowestPct);
    logger.info(`[AutoSwitch] Lowest monitored model: ${lowestPct.toFixed(0)}%, next refresh in ${intervalMs / 1000}s`);

    monitorTimer = setTimeout(() => {
        void runMonitorCycleAndReschedule(accountsService);
    }, intervalMs);
}

/**
 * 单次监控循环：
 * 1. 刷新当前账号额度
 * 2. 检查是否需要切号
 * 3. 如需切号，顺序探测下一个账号
 */
async function runMonitorCycle(accountsService: AccountsRefreshService): Promise<void> {
    if (autoSwitchInProgress) {
        logger.debug('[AutoSwitch] Monitor cycle skipped (in progress)');
        return;
    }

    const config = getAutoSwitchConfig();
    if (!config.enabled) {
        return;
    }

    autoSwitchInProgress = true;
    try {
        // 用 credentialStorage 获取最新的当前账号（不用 accountsService.getCurrentEmail()，它可能是 stale 的）
        const currentEmail = await credentialStorage.getActiveAccount();
        if (!currentEmail) {
            return;
        }

        // 1. 刷新当前账号额度
        logger.debug(`[AutoSwitch] Refreshing current account: ${currentEmail}`);
        try {
            await accountsService.loadAccountQuota(currentEmail);
        } catch (err) {
            logger.warn(`[AutoSwitch] Failed to refresh current account quota: ${err}`);
            return;
        }

        // 2. 检查当前账号是否需要切号
        const currentCache = accountsService.getQuotaCache(currentEmail);
        if (!currentCache || !currentCache.snapshot) {
            return;
        }

        const { trigger, lowModels } = checkShouldSwitch(
            currentCache,
            config.threshold,
            config.monitoredModels,
        );

        if (!trigger) {
            logger.debug('[AutoSwitch] Current account OK, no switch needed');
            return;
        }

        // 冷却期检查
        const now = Date.now();
        if (now - lastAutoSwitchAt < AUTO_SWITCH_COOLDOWN_MS) {
            logger.debug('[AutoSwitch] Cooldown active, skipping switch');
            return;
        }

        logger.info(
            `[AutoSwitch] Current account ${currentEmail} triggered: [${lowModels.join(', ')}] <= ${config.threshold}%`,
        );

        // 3. 顺序探测下一个账号
        await rotateToNextAvailable(accountsService, currentEmail, config);
    } catch (err) {
        logger.error(`[AutoSwitch] Monitor cycle error: ${err}`);
    } finally {
        autoSwitchInProgress = false;
    }
}

/**
 * 顺序探测：从当前账号的下一个开始，逐个刷新并检查额度
 */
async function rotateToNextAvailable(
    accountsService: AccountsRefreshService,
    currentEmail: string,
    config: AutoSwitchConfig,
): Promise<void> {
    const accountsMap = accountsService.getAccountsMap();
    const orderedEmails = Array.from(accountsMap.keys());

    if (orderedEmails.length <= 1) {
        logger.warn('[AutoSwitch] Only one account, cannot rotate');
        return;
    }

    // 找到当前账号在列表中的位置
    const currentIdx = orderedEmails.indexOf(currentEmail);
    if (currentIdx < 0) {
        return;
    }

    // 从下一个开始，循环一圈
    for (let i = 1; i < orderedEmails.length; i++) {
        const idx = (currentIdx + i) % orderedEmails.length;
        const candidateEmail = orderedEmails[idx];
        const candidateState = accountsMap.get(candidateEmail);

        // 跳过不可用账号
        if (!candidateState) {
            continue;
        }
        if (!candidateState.hasPluginCredential || candidateState.isInvalid || candidateState.isForbidden) {
            logger.debug(`[AutoSwitch] Skipping ${candidateEmail} (invalid/forbidden/no credential)`);
            continue;
        }

        // 刷新这个候选账号的额度
        logger.info(`[AutoSwitch] Probing candidate: ${candidateEmail}`);
        try {
            await accountsService.loadAccountQuota(candidateEmail);
        } catch (err) {
            logger.warn(`[AutoSwitch] Failed to probe ${candidateEmail}: ${err}`);
            continue;
        }

        const candidateCache = accountsService.getQuotaCache(candidateEmail);
        if (!candidateCache || !candidateCache.snapshot) {
            continue;
        }

        // 检查候选账号是否满足条件（监控模型额度 > 阈值）
        if (isCandidateSuitable(candidateCache, config.threshold, config.monitoredModels)) {
            // 找到了！执行切换
            logger.info(`[AutoSwitch] ✅ Switching to ${candidateEmail}`);

            // If seamless switch is enabled, inject the new token into the LS
            // so it stays in sync with the plugin's active account.
            const useSeamless = vscode.workspace.getConfiguration('agCockpit')
                .get<boolean>('seamlessSwitchEnabled', true);
            if (useSeamless) {
                try {
                    const { seamlessSwitchService } = await import('./seamlessSwitchService');
                    const credential = await credentialStorage.getCredentialForAccount(candidateEmail);
                    if (credential?.refreshToken) {
                        const result = await seamlessSwitchService.switchTo({
                            email: candidateEmail,
                            refreshToken: credential.refreshToken,
                            tokenType: 'Bearer',
                        });
                        if (!result.success) {
                            logger.warn(`[AutoSwitch] Seamless switch failed for ${candidateEmail}: ${result.error}, continuing with plugin-only switch`);
                        } else {
                            logger.info(`[AutoSwitch] Seamless token injection succeeded for ${candidateEmail}`);
                        }
                    }
                } catch (err) {
                    logger.warn(`[AutoSwitch] Seamless switch error: ${err}`);
                }
            }

            await credentialStorage.setActiveAccount(candidateEmail);
            lastAutoSwitchAt = Date.now();

            // 写入 current_account.json（跨实例同步）
            try {
                const osModule = await import('os');
                const pathModule = await import('path');
                const fsModule = await import('fs');
                const sharedDir = pathModule.join(osModule.homedir(), '.antigravity_cockpit');
                if (!fsModule.existsSync(sharedDir)) {
                    fsModule.mkdirSync(sharedDir, { recursive: true });
                }
                fsModule.writeFileSync(
                    pathModule.join(sharedDir, 'current_account.json'),
                    JSON.stringify({ email: candidateEmail, updated_at: Date.now() }),
                );
            } catch (err2) {
                logger.warn(`[AutoSwitch] Failed to write current_account.json: ${err2}`);
            }

            // 刷新 UI（触发 reactor 重新拉取新账号配额）
            if (onSwitchedCallback) {
                try {
                    onSwitchedCallback();
                } catch (err3) {
                    logger.warn(`[AutoSwitch] Post-switch callback error: ${err3}`);
                }
            }

            // 通知用户
            vscode.window.showInformationMessage(
                `⚡ 自动切号: ${currentEmail} → ${candidateEmail}`,
            );
            return;
        } else {
            logger.debug(`[AutoSwitch] ${candidateEmail} does not meet threshold, trying next...`);
        }
    }

    // 所有账号都不满足
    logger.warn('[AutoSwitch] ❌ No suitable account found after checking all candidates');
    vscode.window.showWarningMessage(
        `⚠️ 自动切号: 所有账号的监控模型额度均低于 ${config.threshold}%，无法切换`,
    );
}

/**
 * 检查账号的监控模型是否低于阈值（需要触发切换）
 */
function checkShouldSwitch(
    cache: AccountQuotaCache,
    threshold: number,
    monitoredModels: string[],
): { trigger: boolean; lowModels: string[] } {
    const snapshot = cache.snapshot;
    if (!snapshot || !snapshot.models || snapshot.models.length === 0) {
        return { trigger: false, lowModels: [] };
    }

    const allModels = (snapshot as { allModels?: typeof snapshot.models }).allModels ?? snapshot.models;
    const lowModels: string[] = [];

    for (const model of allModels) {
        if (monitoredModels.length > 0) {
            const isMonitored = monitoredModels.some(
                m => m.toLowerCase() === (model.modelId ?? model.label ?? '').toLowerCase(),
            );
            if (!isMonitored) {
                continue;
            }
        }

        const pct = model.remainingPercentage ?? 0;
        // threshold=0 时，使用 isExhausted 标志（API返回的百分比可能不精确）
        const isLow = threshold === 0
            ? (model.isExhausted === true || pct <= 0)
            : (pct <= threshold);
        if (isLow) {
            lowModels.push(model.label ?? model.modelId ?? 'unknown');
        }
    }

    return {
        trigger: lowModels.length > 0,
        lowModels,
    };
}

/**
 * 检查账号是否适合作为切换目标
 * 要求：所有监控模型的额度 > threshold
 */
function isCandidateSuitable(
    cache: AccountQuotaCache,
    threshold: number,
    monitoredModels: string[],
): boolean {
    const snapshot = cache.snapshot;
    if (!snapshot || !snapshot.models || snapshot.models.length === 0) {
        return false;
    }
    if (cache.error) {
        return false;
    }

    const allModels = (snapshot as { allModels?: typeof snapshot.models }).allModels ?? snapshot.models;
    let checkedCount = 0;

    for (const model of allModels) {
        if (monitoredModels.length > 0) {
            const isMonitored = monitoredModels.some(
                m => m.toLowerCase() === (model.modelId ?? model.label ?? '').toLowerCase(),
            );
            if (!isMonitored) {
                continue;
            }
        }
        checkedCount++;

        const pct = model.remainingPercentage ?? 0;
        // threshold=0 时，使用 isExhausted 标志
        const isLow = threshold === 0
            ? (model.isExhausted === true || pct <= 0)
            : (pct <= threshold);
        if (isLow) {
            return false;
        }
    }

    // 如果指定了监控模型但一个都没找到 → 不合适
    if (monitoredModels.length > 0 && checkedCount === 0) {
        logger.debug('[AutoSwitch] Candidate rejected: no monitored models found in snapshot');
        return false;
    }

    return checkedCount > 0;
}

/**
 * 向后兼容的入口（旧代码调用）
 * 在定时刷新后调用
 */
export async function runAutoSwitchIfNeeded(
    accountsService: AccountsRefreshService,
): Promise<void> {
    // 如果监控定时器已经在运行，跳过（监控定时器会自己处理）
    if (monitorTimer) {
        return;
    }

    // 否则走旧逻辑（兼容）
    const config = getAutoSwitchConfig();
    if (!config.enabled) {
        return;
    }

    // 启动监控
    startMonitoring(accountsService);
}
