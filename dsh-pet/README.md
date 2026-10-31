# dsh-pet 🐾 · ojin fork

本 fork 在 upstream `PC2005-cloud/dsh-pet` 之上合併了 **ojin** 的長期記憶系統。

## 這個 fork 多了什麼

- **長期記憶（brains.json）**：使用者檔案 + 跨對話記憶；語意（字元 bigram 向量）＋詞彙檢索、重要度、新近度與釘選加權。
- **自動整理**：每輪對話後由 LLM 抽取記憶／檔案更新，每 N 輪對話產生摘要，定期合併重複與衰減久未使用的記憶。
- **記憶感知對話**：對話與碎碎念的 system prompt 會注入「主人檔案 + 相關記憶」。
- **記憶瀏覽器**：`/dsh-pet-7340/memory/view`（HTML，可搜尋、釘選、刪除、重整、匯出、清空）。
- **HTTP API**：`GET/POST/PATCH/DELETE /memory`、`POST /memory/consolidate`、`GET /memory/export`。
- **斜線命令 `/memory`**：`list`（預設）／`remember <內容>`／`recall <查詢>`／`clear`。
- **設定**：`memoryEnabled`、`memoryMaxItems`、`memorySummaryRounds`（皆為全局預設，種類檔案可覆蓋）。
- **飽足度／親密度**：`GET /stats`、`POST /feed`、`POST /pat`；惰性成長、落盤 `stats.json`；記憶瀏覽器頁面可直接餵白飯／摸摸頭。

上游完整說明：<https://github.com/PC2005-cloud/dsh-pet>

許可：程式 MIT；素材禁商用，二創在公開渠道須署名（同上連結）。
