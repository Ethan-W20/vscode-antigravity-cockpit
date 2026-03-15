/**
 * 账号管理 Tree View
 * 
 * 三层结构：
 * - 第1层：邮箱 (带星标表示当前账号)
 * - 第2层：分组 (显示配额百分比)
 * - 第3层：模型明细
 * 
 * 数据来源：
 * - 账号列表：Cockpit Tools (WebSocket)
 * - 配额数据：ReactorCore.fetchQuotaForAccount (插件端逻辑，邮箱匹配)
 */

import * as vscode from 'vscode';
import { logger } from '../shared/log_service';
import { cockpitToolsWs } from '../services/cockpitToolsWs';
import { cockpitToolsLocal } from '../services/cockpitToolsLocal';
import { AccountsRefreshService } from '../services/accountsRefreshService';
import { ModelQuotaInfo, QuotaGroup } from '../shared/types';
import { t } from '../shared/i18n';
import { configService } from '../shared/config_service';

// ============================================================================
// Types
// ============================================================================

// Types moved to AccountsRefreshService

// ============================================================================
// Tree Node Types
// ============================================================================

export type AccountTreeItem = AccountNode | GroupNode | ModelNode | ToolsStatusNode | QuotaSummaryNode | ModelSummaryNode | LoadingNode | ErrorNode;

/**
 * 账号节点 (第1层)
 */
export class AccountNode extends vscode.TreeItem {
    constructor(
        public readonly email: string,
        public readonly isCurrent: boolean,
        public readonly isInvalid?: boolean,
        public readonly isForbidden?: boolean,
        public readonly tier?: string,
    ) {
        super(email, vscode.TreeItemCollapsibleState.Expanded);

        // 图标优先级：失效 > 无权限 > tier类型
        if (isInvalid) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
        } else if (isForbidden) {
            this.iconPath = new vscode.ThemeIcon('lock', new vscode.ThemeColor('errorForeground'));
        } else {
            // 根据 tier 显示不同颜色
            const upperTier = (tier || '').toUpperCase();
            if (upperTier.includes('ULTRA')) {
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
            } else if (upperTier.includes('PRO')) {
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
            } else {
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.purple'));
            }
        }

        // description: 当前账号显示 ⭐
        this.description = isCurrent ? '⭐' : '';

        // Tooltip
        const parts = [
            `${t('accountTree.tooltipEmail')}: ${email}`,
            isInvalid ? `⚠️ ${t('accountsRefresh.authExpired')}` : '',
            isForbidden ? `🔒 ${t('accountsRefresh.forbidden')}` : '',
            isCurrent && !isInvalid ? t('accountTree.currentAccount') : '',
        ].filter(Boolean);
        this.tooltip = parts.join('\n');

        // Context for menus
        this.contextValue = isCurrent ? 'accountCurrent' : 'account';
    }
}

/**
 * 分组节点 (第2层)
 */
export class GroupNode extends vscode.TreeItem {
    constructor(
        public readonly group: QuotaGroup,
        public readonly accountEmail: string,
    ) {
        super(group.groupName, vscode.TreeItemCollapsibleState.Collapsed);

        const pct = Math.round(group.remainingPercentage);
        
        // Status icon based on percentage
        let color: vscode.ThemeColor | undefined;
        if (pct <= 10) {
            color = new vscode.ThemeColor('errorForeground');
        } else if (pct <= 30) {
            color = new vscode.ThemeColor('editorWarning.foreground');
        } else {
            color = new vscode.ThemeColor('charts.green');
        }

        this.iconPath = new vscode.ThemeIcon('circle-filled', color);
        
        // 简短倒计时格式
        const resetTime = group.timeUntilResetFormatted || '-';
        this.description = `${pct}%  ${resetTime}`;
        
        this.tooltip = [
            `${t('groupNode.group')}: ${group.groupName}`,
            `${t('groupNode.quota')}: ${pct}%`,
            `${t('groupNode.reset')}: ${group.resetTimeDisplay}`,
            t('groupNode.modelsCount', { count: group.models.length.toString() }),
        ].join('\n');

        this.contextValue = 'group';
    }
}

/**
 * 模型节点 (第3层)
 */
export class ModelNode extends vscode.TreeItem {
    constructor(
        public readonly model: ModelQuotaInfo,
        public readonly accountEmail: string,
    ) {
        super(model.label, vscode.TreeItemCollapsibleState.None);

        const pct = Math.round(model.remainingPercentage ?? 0);
        const resetStr = model.timeUntilResetFormatted || '-';

        // 图标颜色根据额度
        let color: vscode.ThemeColor;
        if (pct <= 10) {
            color = new vscode.ThemeColor('errorForeground');
        } else if (pct <= 30) {
            color = new vscode.ThemeColor('editorWarning.foreground');
        } else {
            color = new vscode.ThemeColor('charts.green');
        }
        this.iconPath = new vscode.ThemeIcon('symbol-method', color);

        // description: 额度% + 倒计时
        this.description = `${pct}%  ⏱${resetStr}`;

        // tooltip: 五格进度条
        const filled = Math.round(pct / 20); // 0-5
        const bar = '██'.repeat(filled) + '░░'.repeat(5 - filled);
        this.tooltip = [
            model.label,
            `${t('accountTree.tooltipModelId')}: ${model.modelId}`,
            `额度: ${pct}%  [${bar}]`,
            `重置: ${resetStr}`,
        ].join('\n');
        this.contextValue = 'model';
    }
}
/**
 * 配额汇总节点（顶层，可展开）
 */
export class QuotaSummaryNode extends vscode.TreeItem {
    constructor(
        public readonly totalPct: number,
        tooltipText: string,
        public readonly modelSummaries: Array<{ modelId: string; label: string; totalPct: number; count: number }>,
    ) {
        super(`总配额: ${totalPct}%`, vscode.TreeItemCollapsibleState.Expanded);

        let color: vscode.ThemeColor;
        if (totalPct <= 50) {
            color = new vscode.ThemeColor('errorForeground');
        } else if (totalPct <= 150) {
            color = new vscode.ThemeColor('editorWarning.foreground');
        } else {
            color = new vscode.ThemeColor('charts.green');
        }
        this.iconPath = new vscode.ThemeIcon('graph', color);
        this.tooltip = tooltipText;
        this.contextValue = 'quotaSummary';
    }
}

/**
 * 模型汇总子节点（显示单个模型的总配额）
 */
export class ModelSummaryNode extends vscode.TreeItem {
    constructor(
        public readonly modelId: string,
        label: string,
        totalPct: number,
        accountCount: number,
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);

        let color: vscode.ThemeColor;
        if (totalPct <= 50) {
            color = new vscode.ThemeColor('errorForeground');
        } else if (totalPct <= 150) {
            color = new vscode.ThemeColor('editorWarning.foreground');
        } else {
            color = new vscode.ThemeColor('charts.green');
        }
        this.iconPath = new vscode.ThemeIcon('symbol-method', color);
        this.description = `${totalPct}%  (${accountCount}个账号)`;
        this.tooltip = `${label}\n总配额: ${totalPct}%\n账号数: ${accountCount}`;
        this.contextValue = 'modelSummary';
    }
}

/**
 * Tools 连接状态节点
 */
export class ToolsStatusNode extends vscode.TreeItem {
    constructor(
        public readonly accountEmail: string,
        public readonly online: boolean,
    ) {
        super(
            online ? 'Tools: Online' : 'Tools: Offline',
            vscode.TreeItemCollapsibleState.None,
        );

        this.iconPath = new vscode.ThemeIcon(
            online ? 'link' : 'debug-disconnect',
            online ? new vscode.ThemeColor('charts.green') : new vscode.ThemeColor('errorForeground'),
        );
        this.tooltip = online
            ? 'Cockpit Tools WebSocket: Connected'
            : 'Cockpit Tools WebSocket: Disconnected';
        this.contextValue = online ? 'toolsOnline' : 'toolsOffline';
    }
}

/**
 * 加载中节点
 */
export class LoadingNode extends vscode.TreeItem {
    constructor() {
        super(t('accountTree.loading'), vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('loading~spin');
    }
}

/**
 * 错误节点
 */
export class ErrorNode extends vscode.TreeItem {
    constructor(message: string) {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
        this.contextValue = 'error';
    }
}

// ============================================================================
// Tree Data Provider
// ============================================================================

export class AccountTreeProvider implements vscode.TreeDataProvider<AccountTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<AccountTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private refreshSubscription: vscode.Disposable;

    constructor(private readonly refreshService: AccountsRefreshService) {
        this.refreshSubscription = this.refreshService.onDidUpdate(() => {
            this._onDidChangeTreeData.fire();
        });
    }

    dispose(): void {
        this.refreshSubscription.dispose();
    }

    /**
     * 手动刷新（带冷却）
     */
    async manualRefresh(): Promise<boolean> {
        return this.refreshService.manualRefresh();
    }

    /**
     * 刷新所有账号的配额（串行，静默加载）
     * 使用锁机制防止并发执行，避免重复 API 请求
     */
    async refreshQuotas(): Promise<void> {
        await this.refreshService.refreshQuotas();
    }

    /**
     * 刷新所有账号列表
     */
    async refresh(): Promise<void> {
        await this.refreshService.refresh();
    }

    /**
     * 加载指定账号的配额（显示加载状态，用于首次加载）
     */
    async loadAccountQuota(email: string): Promise<void> {
        await this.refreshService.loadAccountQuota(email);
    }

    getTreeItem(element: AccountTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: AccountTreeItem): Promise<AccountTreeItem[]> {
        if (!element) {
            // Root level: account list
            return this.getRootChildren();
        }

        if (element instanceof AccountNode) {
            // Account children: groups or loading
            return this.getAccountChildren(element.email);
        }

        if (element instanceof GroupNode) {
            // Group children: models
            return element.group.models.map(m => new ModelNode(m, element.accountEmail));
        }

        if (element instanceof QuotaSummaryNode) {
            // 汇总节点的子节点：每个模型的总配额
            return element.modelSummaries.map(s =>
                new ModelSummaryNode(s.modelId, s.label, s.totalPct, s.count),
            );
        }

        return [];
    }

    private getRootChildren(): AccountTreeItem[] {
        const initError = this.refreshService.getInitError();
        if (initError) {
            return [new ErrorNode(initError)];
        }

        if (!this.refreshService.isInitialized()) {
            return [new LoadingNode()];
        }

        const accounts = this.refreshService.getAccountsMap();
        if (accounts.size === 0) {
            return [new ErrorNode(t('accountTree.noAccounts'))];
        }

        // 计算选中模型的总配额
        const summaryNode = this.buildQuotaSummaryNode(accounts);

        // Tools 连接状态（仅顶部显示一次）
        const rootItems: AccountTreeItem[] = [];
        if (summaryNode) {
            rootItems.push(summaryNode);
        }
        rootItems.push(new ToolsStatusNode('', cockpitToolsWs.isConnected));

        // 保持账号原始顺序，不按当前账号排序
        for (const [email, account] of accounts) {
            rootItems.push(
                new AccountNode(
                    email,
                    account.isCurrent,
                    account.isInvalid,
                    account.isForbidden,
                    account.tier,
                ),
            );
        }

        return rootItems;
    }

    /**
     * 构建配额汇总节点：对选中（可见）模型求和各账号的额度百分比
     */
    private buildQuotaSummaryNode(
        accounts: ReadonlyMap<string, import('../services/accountsRefreshService').AccountState>,
    ): QuotaSummaryNode | null {
        const config = configService.getConfig();
        const visibleModels = config.visibleModels; // string[] of modelIds

        // 无选中模型 => 不显示汇总
        if (!visibleModels || visibleModels.length === 0) {
            return null;
        }

        // 对每个 visible model 汇总所有账号的额度
        const modelTotals = new Map<string, { label: string; totalPct: number; count: number }>();

        for (const [email] of accounts) {
            const cache = this.refreshService.getQuotaCache(email);
            if (!cache || cache.loading || cache.error || !cache.snapshot) {
                continue;
            }

            const allModels = cache.snapshot.allModels ?? cache.snapshot.models ?? [];

            for (const model of allModels) {
                if (!visibleModels.includes(model.modelId)) {
                    continue;
                }
                const existing = modelTotals.get(model.modelId);
                const pct = Math.round(model.remainingPercentage ?? 0);
                if (existing) {
                    existing.totalPct += pct;
                    existing.count++;
                } else {
                    modelTotals.set(model.modelId, { label: model.label, totalPct: pct, count: 1 });
                }
            }
        }

        if (modelTotals.size === 0) {
            // 即使没有加载数据，仍显示 0% 汇总
            return new QuotaSummaryNode(0, '📊 选中模型配额汇总\n\n尚未加载额度数据，请点击刷新', []);
        }

        // 汇总
        let grandTotal = 0;
        const tooltipLines: string[] = ['📊 选中模型配额汇总', ''];
        const modelSummaryList: Array<{ modelId: string; label: string; totalPct: number; count: number }> = [];

        for (const [modelId, info] of modelTotals) {
            grandTotal += info.totalPct;
            tooltipLines.push(`${info.label}: ${info.totalPct}% (${info.count}个账号)`);
            modelSummaryList.push({ modelId, label: info.label, totalPct: info.totalPct, count: info.count });
        }

        return new QuotaSummaryNode(grandTotal, tooltipLines.join('\n'), modelSummaryList);
    }

    private getAccountChildren(email: string): AccountTreeItem[] {
        const cache = this.refreshService.getQuotaCache(email);
        const account = this.refreshService.getAccount(email);

        if (account && !account.hasPluginCredential) {
            return [
                new ErrorNode(t('accountTree.notImported')),
            ];
        }

        // 未加载（无缓存且未在加载）
        if (!cache) {
            return [new ErrorNode('未刷新')];
        }

        // 正在加载中
        if (cache.loading) {
            return [new LoadingNode()];
        }

        // 错误
        if (cache.error) {
            return [
                new ErrorNode(cache.error),
            ];
        }

        // 显示分组
        const children: AccountTreeItem[] = [];
        const snapshot = cache.snapshot;

        if (snapshot.groups && snapshot.groups.length > 0) {
            // 有分组，显示分组
            for (const group of snapshot.groups) {
                children.push(new GroupNode(group, email));
            }
        } else if (snapshot.models.length > 0) {
            // 无分组但有模型，直接显示模型
            for (const model of snapshot.models) {
                children.push(new ModelNode(model, email));
            }
        } else {
            children.push(new ErrorNode(t('accountTree.noQuotaData')));
        }


        return children;
    }

    /**
     * 获取当前账号
     */
    getCurrentEmail(): string | null {
        return this.refreshService.getCurrentEmail();
    }

    /**
     * 获取指定账号的 ID (从 Cockpit Tools)
     */
    async getAccountId(email: string): Promise<string | null> {
        return this.refreshService.getAccountId(email);
    }
}

// ============================================================================
// Commands
// ============================================================================

export function registerAccountTreeCommands(
    context: vscode.ExtensionContext,
    provider: AccountTreeProvider,
): void {
    // Refresh (带冷却)
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.accountTree.refresh', async () => {
            // 手动触发重连
            cockpitToolsWs.ensureConnected();
            await provider.manualRefresh();
        }),
    );

    // Load account quota
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.accountTree.loadAccountQuota', async (email: string) => {
            await provider.loadAccountQuota(email);
        }),
    );

    // Refresh single account quota (inline button)
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.accountTree.refreshAccount', async (node: AccountNode) => {
            if (node?.email) {
                await provider.loadAccountQuota(node.email);
            }
        }),
    );

    // Switch account
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.accountTree.switch', async (node: AccountNode) => {
            const config = vscode.workspace.getConfiguration('agCockpit');
            const useSeamless = config.get<boolean>('seamlessSwitchEnabled', true);
            const needConfirm = config.get<boolean>('switchConfirmation', true);

            if (needConfirm) {
                const currentEmail = provider.getCurrentEmail();
                const confirmMessage = currentEmail
                    ? t('account.switch.confirmWithCurrent', { current: currentEmail, target: node.email })
                    : t('account.switch.confirmNoCurrent', { target: node.email });

                const confirm = await vscode.window.showWarningMessage(
                    confirmMessage,
                    { modal: true },
                    t('account.switch.confirmOk'),
                );

                if (confirm !== t('account.switch.confirmOk')) {
                    return;
                }
            }

            if (useSeamless) {
                const { credentialStorage } = await import('../auto_trigger/credential_storage');
                const { seamlessSwitchService } = await import('../services/seamlessSwitchService');
                const credential = await credentialStorage.getCredentialForAccount(node.email);

                if (!credential || !credential.refreshToken) {
                    vscode.window.showWarningMessage(`无法无感换号：账号 ${node.email} 缺少凭据`);
                    return;
                }

                const result = await seamlessSwitchService.switchTo({
                    email: node.email,
                    refreshToken: credential.refreshToken,
                    tokenType: 'Bearer',
                });

                if (!result.success) {
                    vscode.window.showErrorMessage(`无感换号失败：${result.error || '未知错误'}`);
                    return;
                }

                await credentialStorage.setActiveAccount(node.email);

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
                        JSON.stringify({ email: node.email, updated_at: Date.now() }),
                    );
                } catch (error) {
                    logger.warn('[AccountTree] Failed to write current_account.json after seamless switch', error);
                }

                vscode.window.showInformationMessage(`已无感切换到账号：${node.email}`);
                await provider.refresh();
                return;
            }

            const accountId = cockpitToolsLocal.getAccountIdByEmail(node.email);
            if (!accountId) {
                vscode.window.showWarningMessage(t('accountTree.cannotGetAccountId'));
                return;
            }

            // 2. 再检查 WS 连接，未连接则等待重连
            if (!cockpitToolsWs.isConnected) {
                logger.info('[AccountTree] WS 未连接，尝试等待重连后执行切换...');
                const connected = await cockpitToolsWs.waitForConnection(5000);
                if (!connected) {
                    const launchAction = t('accountTree.launchCockpitTools');
                    const downloadAction = t('accountTree.downloadCockpitTools');
                    const action = await vscode.window.showWarningMessage(
                        t('accountTree.cockpitToolsNotRunning'),
                        launchAction,
                        downloadAction,
                    );
                    
                    if (action === launchAction) {
                        vscode.commands.executeCommand('agCockpit.accountTree.openManager');
                    } else if (action === downloadAction) {
                        vscode.env.openExternal(vscode.Uri.parse('https://github.com/jlcodes99/antigravity-cockpit-tools/releases'));
                    }
                    return;
                }
                logger.info('[AccountTree] WS 重连成功，继续执行切换操作');
            }

            // 3. 通过 WebSocket 请求切换
            const sent = cockpitToolsWs.requestSwitchAccount(accountId);
            if (sent) {
                vscode.window.showInformationMessage(
                    t('accountTree.switchingTo', { email: node.email }),
                );
            } else {
                vscode.window.showErrorMessage(t('accountTree.sendSwitchFailed'));
            }
        }),
    );

    // Open Cockpit Tools
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.accountTree.openManager', async () => {
            const platform = process.platform;
            let command: string;

            if (platform === 'darwin') {
                command = 'open -a "Cockpit Tools"';
            } else if (platform === 'win32') {
                command = 'start "" "Cockpit Tools"';
            } else {
                command = 'cockpit-tools';
            }

            try {
                const { exec } = await import('child_process');
                exec(command, (error) => {
                    if (error) {
                        logger.warn('[AccountTree] Failed to open Cockpit Tools:', error);
                        vscode.window.showWarningMessage(t('accountTree.cannotOpenCockpitTools'));
                    }
                });
            } catch {
                vscode.window.showWarningMessage(t('accountTree.cannotOpenCockpitTools'));
            }
        }),
    );
}
