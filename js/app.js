/**
 * 立替精算チェックツール
 * - 事前名簿不要・個人情報入力不要（空欄時は「立替者1, 2...」）
 * - 処理済み書類の検算（申告額 VS レシート実額の差額チェック）
 * - ローカルJSONファイルへの自動保存（File System Access API）&バックアップ対応
 */

const STORAGE_KEY = 'seisan_data_v1';

// アプリケーション状態
let appData = {
    updatedAt: new Date().toISOString(),
    groups: [] // { id, name, budget, receipts: [ { id, payer, actualAmount, declaredAmount, date, memo } ] }
};

let activeGroupID = null;
let fileHandle = null; // File System Access API 用ハンドル

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    loadFromLocalStorage();
    bindEvents();
    renderGroupList();
});

// イベント登録
function bindEvents() {
    // 団体追加
    document.getElementById('form-add-group').addEventListener('submit', (e) => {
        e.preventDefault();
        const nameInput = document.getElementById('input-group-name');
        const budgetInput = document.getElementById('input-group-budget');
        const name = nameInput.value.trim();
        const budget = parseInt(budgetInput.value, 10) || 0;

        if (!name) return;

        const newGroup = {
            id: 'grp_' + Date.now(),
            name,
            budget,
            receipts: []
        };

        appData.groups.push(newGroup);
        nameInput.value = '';
        budgetInput.value = '';

        selectGroup(newGroup.id);
        saveData();
    });

    // レシート検算登録
    document.getElementById('form-add-receipt').addEventListener('submit', (e) => {
        e.preventDefault();
        const group = getActiveGroup();
        if (!group) return;

        const payerInput = document.getElementById('input-payer');
        const actualInput = document.getElementById('input-actual-amount');
        const declaredInput = document.getElementById('input-declared-amount');
        const dateInput = document.getElementById('input-receipt-date');
        const memoInput = document.getElementById('input-memo');

        const actualAmount = parseInt(actualInput.value, 10);
        if (isNaN(actualAmount) || actualAmount < 0) return;

        // 申告額が空欄の場合は「実額と同額（計算ミスなし）」として扱う
        const parsedDeclaredAmount = declaredInput.value !== ''
            ? parseInt(declaredInput.value, 10)
            : actualAmount;
        const declaredAmount = Number.isNaN(parsedDeclaredAmount) || parsedDeclaredAmount < 0
            ? actualAmount
            : parsedDeclaredAmount;

        // 申告額が空欄の場合は「立替者1」「立替者2」...を自動採番
        let payer = payerInput.value.trim();
        if (!payer) {
            payer = generateNextPayerLabel(group);
        }

        const date = dateInput.value;
        const memo = memoInput.value.trim();

        // 重複レシートチェック（同日・同額がすでに登録されていないか）
        const duplicate = date ? findDuplicateReceipt(date, actualAmount) : null;
        if (duplicate) {
            const proceed = confirm(
                `【重複アラート】\n同日（${date}）・同額（${actualAmount.toLocaleString()}円）のレシートが既に登録されています。\n（団体: ${duplicate.groupName} / 立替担当者: ${duplicate.payer}）\n\n二重計上の可能性があります。このまま登録しますか？`
            );
            if (!proceed) return;
        }

        group.receipts.push({
            id: 'rcp_' + Date.now(),
            payer,
            actualAmount,
            declaredAmount,
            date,
            memo
        });

        // 連続入力しやすいように、立替担当者名は残すかクリアにするか選択（ここではクリアして次の入力へフォーカス）
        actualInput.value = '';
        declaredInput.value = '';
        memoInput.value = '';
        actualInput.focus();

        renderWorkspace();
        renderGroupList();
        saveData();
    });

    // ローカルJSONファイル連携（File System Access API）
    document.getElementById('btn-connect-file').addEventListener('click', connectLocalJsonFile);

    // JSONバックアップ手動ダウンロード
    document.getElementById('btn-export-json').addEventListener('click', exportJsonDownload);

    // JSON読み込み
    document.getElementById('input-import-json').addEventListener('change', importJsonFile);

    // 全団体CSV出力（Excel用）
    document.getElementById('btn-export-csv').addEventListener('click', exportAllCsv);
}

// 次の無記名立替担当者ラベルを生成（例: 担当者1, 担当者2...）
function generateNextPayerLabel(group) {
    const existingPayers = new Set(group.receipts.map(r => r.payer));
    let index = 1;
    while (existingPayers.has(`担当者${index}`)) {
        index++;
    }
    return `担当者${index}`;
}

// 全団体黄疸での重複レシート検知
function findDuplicateReceipt(date, actualAmount) {
    for (const grp of appData.groups) {
        for (const r of grp.receipts) {
            if (r.date === date && r.actualAmount === actualAmount) {
                return { groupName: grp.name, payer: r.payer };
            }
        }
    }
    return null;
}

function getActiveGroup() {
    return appData.groups.find(g => g.id === activeGroupID) || null;
}

function selectGroup(groupId) {
    activeGroupID = groupId;
    renderGroupList();
    renderWorkspace();
}

//団体削除
function deleteGroup(groupId, event) {
    event.stopPropagation();
    if (!confirm('この団体と登録されたレシートデータを削除しますか？')) return;
    appData.groups = appData.groups.filter(g => g.id !== groupId);
    if (activeGroupID === groupId) {
        activeGroupID = null;
    }
    renderGroupList();
    renderWorkspace();
    saveData();
}

// レシート削除
function deleteReceipt(receiptId) {
    const group = getActiveGroup();
    if (!group) return;
    group.receipts = group.receipts.filter(r => r.id !== receiptId);
    renderWorkspace();
    renderGroupList();
    saveData();
}

// 団体一覧の描画
function renderGroupList() {
    const listEl = document.getElementById('group-list');
    listEl.innerHTML = '';

    appData.groups.forEach(group => {
        const actualTotal = group.receipts.reduce((sum, r) => sum + r.actualAmount, 0);
        const isOver = actualTotal > group.budget;

        const li = document.createElement('li');
        li.className = `group-item ${group.id === activeGroupID ? 'active' : ''}`;
        li.onclick = () => selectGroup(group.id);

        li.innerHTML = `
            <div>
                <div>${escapeHtml(group.name)}</div>
                <span class="meta">
                    予算: ${group.budget.toLocaleString()}円 / 確定:
                    <strong style="color:${isOver ? '#dc2626' : 'inherit'}">${actualTotal.toLocaleString()}円</strong>
                </span>
            </div>
            <button class="btn btn-danger-sm" onclick="deleteGroup('${group.id}', event)">削除</button>
        `;
        listEl.appendChild(li);
    });
}

// 作業エリアの描画
function renderWorkspace() {
    const group = getActiveGroup();
    const emptyEl = document.getElementById('empty-state');
    const workEl = document.getElementById('active-workspace');

    if (!group) {
        emptyEl.classList.remove('hidden');
        workEl.classList.add('hidden');
        return;
    }

    emptyEl.classList.add('hidden');
    workEl.classList.remove('hidden');

    // 集計計算
    const declaredTotal = group.receipts.reduce((sum, r) => sum + r.declaredAmount, 0);
    const actualTotal = group.receipts.reduce((sum, r) => sum + r.actualAmount, 0);
    const budgetRemaining = group.budget - actualTotal;
    const variance = declaredTotal - actualTotal; // プラスなら団体が過大申告（多く申告または、請求していた）

    // サマリー表示更新
    document.getElementById('disp-group-name').textContent = group.name;
    document.getElementById('disp-budget').textContent = `配分予算: ${group.budget.toLocaleString()}円`;
    document.getElementById('disp-declared-total').textContent = `${declaredTotal.toLocaleString()}円`;
    document.getElementById('disp-actual-total').textContent = `${actualTotal.toLocaleString()}円`;

    const actualCard = document.getElementById('disp-actual-total').parentElement;
    const budgetDiffEl = document.getElementById('disp-budget-diff');
    if (budgetRemaining < 0) {
        actualCard.classList.add('over-budget');
        budgetDiffEl.textContent = `【警告】予算オーバー: ${Math.abs(budgetRemaining).toLocaleString()}円超過`;
        budgetDiffEl.style.color = '#dc2626';
    } else {
        actualCard.classList.remove('over-budget');
        budgetDiffEl.textContent = `予算残高: ${budgetRemaining.toLocaleString()}円`;
        budgetDiffEl.style.color = '';
    }

    const varianceEl = document.getElementById('disp-variance');
    const varianceNoteEl = document.getElementById('disp-variance-note');
    if (variance > 0) {
        varianceEl.textContent = `+${variance.toLocaleString()}円`;
        varianceEl.style.color = '#dc2626';
        varianceNoteEl.textContent = `団体が${variance.toLocaleString()}円多く申告（過大請求の恐れ）`;
    } else if (variance < 0) {
        varianceEl.textContent = `${variance.toLocaleString()}円`;
        varianceEl.style.color = '#2563eb';
        varianceNoteEl.textContent = `団体が${Math.abs(variance).toLocaleString()}円少なく申告（過少請求の恐れ）`;
    } else {
        varianceEl.textContent = `0円`;
        varianceEl.style.color = '#059669';
        varianceNoteEl.textContent = `申告額とレシート記載額が完全一致`;
    }

    // クイック選択用「立替担当者タグ」生成
    const quickTagsEl = document.getElementById('payer-quick-buttons');
    quickTagsEl.innerHTML = '';
    const uniquePayers = [...new Set(group.receipts.map(r => r.payer))];
    uniquePayers.forEach(payer => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tag-btn';
        btn.textContent = payer;
        btn.onclick = () => {
            document.getElementById('input-payer').value = payer;
            document.getElementById('input-actual-amount').focus();
        };
        quickTagsEl.appendChild(btn);
    });

    // レシート一覧テーブル描画
    document.getElementById('receipt-count').textContent = `${group.receipts.length}枚`;
    const tbody = document.getElementById('receipt-list-body');
    tbody.innerHTML = '';
    
    group.receipts.forEach((r, idx) => {
        const diff = r.declaredAmount - r.actualAmount;
        const hasDiff = diff !== 0;
        const tr = document.createElement('tr');
        if (hasDiff) tr.classList.add('row-alert');

        let diffHtml = '0円';
        if (diff > 0) diffHtml = `<span class="diff-plus">+${diff.toLocaleString()}円（過大）</span>`;
        if (diff < 0) diffHtml = `<span class="diff-minus">${diff.toLocaleString()}円（過少）</span>`;

        tr.innerHTML = `
            <td>#${idx + 1}</td>
            <td><strong>${escapeHtml(r.payer)}</strong></td>
            <td>${r.date || '-'}</td>
            <td class="num">${r.declaredAmount.toLocaleString()}円</td>
            <td class="num"><strong>${r.actualAmount.toLocaleString()}円</strong></td>
            <td class="num">${diffHtml}</td>
            <td>${escapeHtml(r.memo)}</td>
            <td><button class="btn btn-danger-sm" onclick="deleteReceipt('${r.id}')">削除</button></td>
        `;
        tbody.appendChild(tr);
    });

    // 立替担当者別支払い合算 ＆ 金種計算描画
    renderPayerSummaryAndDenominations(group);
}

// 立替担当者別支払い合計と金種計算の描画
function renderPayerSummaryAndDenominations(group) {
    const payerMap = new Map(); // payer -> { count, total }
    const summaryBody = document.getElementById('payer-summary-body');
    summaryBody.innerHTML = '';

    group.receipts.forEach(r => {
        if (!payerMap.has(r.payer)) {
            payerMap.set(r.payer, { count: 0, total: 0 });
        }
        const entry = payerMap.get(r.payer);
        entry.count += 1;
        entry.total += r.actualAmount;
    });

    const totalDenoms = { 10000: 0, 5000: 0, 1000: 0, 500: 0, 100: 0, 50: 0, 10: 0, 5: 0, 1: 0 };

    payerMap.forEach((data, payer) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${escapeHtml(payer)}</strong></td>
            <td class="num">${data.count}枚</td>
            <td class="num"><strong>${data.total.toLocaleString()}円</strong></td>
        `;
        summaryBody.appendChild(tr);

        // 個人ごとの支払額に対して必要な金種を合算（全員にお釣りなしで渡すため）
        const denoms = calculateDenominations(data.total);
        Object.keys(totalDenoms).forEach(coin => {
            totalDenoms[coin] += denoms[coin];
        });
    });

    // 金種グリッド描画
    const denomGrid = document.getElementById('denomination-grid');
    denomGrid.innerHTML = '';
    const coinOrder = [10000, 5000, 1000, 500, 100, 50, 10, 5, 1];

    coinOrder.forEach(coin => {
        const unit = coin >= 1000 ? '円札' : '円玉';
        const div = document.createElement('div');
        div.className = 'denom-item';
        div.innerHTML = `
            <span class="coin-name">${coin.toLocaleString()}${unit}</span>
            <span class="coin-count">${totalDenoms[coin]} 枚</span>
        `;
        denomGrid.appendChild(div);
    });
}

// 金額から最小枚数の金種を計算するアルゴリズム
function calculateDenominations(amount) {
    let remaining = amount;
    const coins = [10000, 5000, 1000, 500, 100, 50, 10, 5, 1];
    const result = {};

    coins.forEach(coin => {
        result[coin] = Math.floor(remaining / coin);
        remaining %= coin;
    });
    return result;
}

// ==========================================
// ローカルファイル保存・読込・CSV出力処理
// ==========================================

async function saveData() {
    appData.updatedAt = new Date().toISOString();
    const jsonStr = JSON.stringify(appData, null, 2);

    // 1. ブラウザのlocalStorageにバックアップ
    localStorage.setItem(STORAGE_KEY, jsonStr);

    // 2. File System Access API でローカルファイルと連携済みの場合は直接上書き保存
    const statusEl = document.getElementById('save-status');
    if (fileHandle) {
        try {
            const writable = await fileHandle.createWritable();
            await writable.write(jsonStr);
            await writable.close();
            statusEl.textContent = `ローカルJSONに自動保存済（${new Date().toLocaleTimeString()}）`;
            statusEl.className = 'status-text saved';
        } catch (err) {
            console.error('ローカルファイル書き込みエラー:', err);
            statusEl.textContent = 'ローカル自動保存に失敗（再連携してください）';
            statusEl.className = 'status-text';
        }
    } else {
        statusEl.textContent = `一時保存済（${new Date().toLocaleTimeString()}）`;
    }
}

function loadFromLocalStorage() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            appData = JSON.parse(saved);
        } catch (e) {
            console.error('保存データの読込に失敗しました', e);
        }
    }
}

// PC内のJSONファイルを選択して自動保存先として紐づける
async function connectLocalJsonFile() {
    if (!window.showSaveFilePicker) {
        alert('お使いのブラウザはローカル直接保存に対応していません。「JSONバックアップ保存」ボタンをご利用ください。');
        return;
    }
    try {
        fileHandle = await window.showSaveFilePicker({
            suggestedName: 'seisan_data.json',
            types: [{
                description: 'JSONファイル',
                accept: { 'application/json': ['.json'] }
            }]
        });
        await saveData();
        alert('ローカルJSONファイルと連携しました。以降の入力は自動的にこのファイルへ上書き保存されます。');
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error(err);
        }
    }
}

// JSONエクスポート（フォールバック・バックアップ用）
function exportJsonDownload() {
    const jsonStr = JSON.stringify(appData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `seisan_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

// JSONインポート
function importJsonFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const imported = JSON.parse(e.target.result);
            if (imported && Array.isArray(imported.groups)) {
                appData = imported;
                activeGroupID = appData.groups.length > 0 ? appData.groups[0].id : null;
                renderGroupList();
                renderWorkspace();
                saveData();
                alert('JSONファイルデータを読み込みました。');
            } else {
                alert('不正なJSONフォーマットです。');
            }
        } catch (err) {
            alert('JSONファイルの読み込みに失敗しました。');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// Excel用 CSV出力（UTF-8 BOM付き・立替担当者別確定支払額＆受領サイン欄付き）
function exportAllCsv() {
    if (appData.groups.length === 0) {
        alert('出力する団体データがありません');
        return;
    }

    const rows = [
        ['団体名', '配分予算（円）', '立替担当者（識別）', 'レシート枚数', '団体申告合計（円）', '監査確定支払額（円）', '差額（円）', '受領サイン欄']
    ];

    appData.groups.forEach(group => {
        const payerMap = new Map();
        group.receipts.forEach(r => {
            if (!payerMap.has(r.payer)) {
                payerMap.set(r.payer, { count: 0, declared: 0, actual: 0 });
            }
            const entry = payerMap.get(r.payer);
            entry.count += 1;
            entry.declared += r.declaredAmount;
            entry.actual += r.actualAmount;
        });

        if (payerMap.size === 0) {
            rows.push([group.name, group.budget, '（申告なし）', 0, 0, 0, 0, '']);
        } else {
            payerMap.forEach((data, payer) => {
                const diff = data.declared - data.actual;
                rows.push([
                    group.name,
                    group.budget,
                    payer,
                    data.count,
                    data.declared,
                    data.actual,
                    diff,
                    '' // 現金受け渡し時などの受領印・サイン欄
                ]);
            });
        }
    });

    const csvContent = rows.map(row => 
        row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ).join('\r\n');

    // Excel文字化け防止のためUTF-8 BOMを付与
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `精算確定一覧表_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// XSS対策エスケープ
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}