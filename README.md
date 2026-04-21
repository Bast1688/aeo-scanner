# AEO Scanner

AI 搜尋友好度偵測工具。後端真實抓取 robots.txt / sitemap / llms.txt / 首頁 HTML，送給 Claude 分析，回傳真實評分。

## 部署到 Vercel（5 分鐘）

### 1. 安裝 Vercel CLI（如果還沒有）
```bash
npm i -g vercel
```

### 2. 進入此資料夾，執行部署
```bash
cd aeo-scanner
vercel
```
按提示操作，選擇 Deploy（預設選項即可）。

### 3. 設定 Anthropic API Key（必要）
```bash
vercel env add ANTHROPIC_API_KEY
```
輸入你的 API Key（從 https://console.anthropic.com 取得）。

### 4. 重新部署使環境變數生效
```bash
vercel --prod
```

完成！你會得到一個 `https://your-project.vercel.app` 的網址，即可給客戶使用。

---

## 檔案結構

```
aeo-scanner/
├── public/
│   └── index.html      # 前端 UI（淡色設計）
├── api/
│   └── scan.js         # Vercel Edge Function（後端）
└── vercel.json         # Vercel 設定
```

## 技術說明

- **前端**：純 HTML/CSS/JS，無框架依賴
- **後端**：Vercel Edge Function（`api/scan.js`）
  - 使用 `Promise.all` 同時抓取 4 個端點：robots.txt、sitemap.xml、llms.txt、首頁
  - 將真實內容送給 Claude Sonnet 分析
  - 回傳結構化 JSON 評分
- **評分維度**：爬蟲友好度、內容品質、AI 能見度

## 費用估算

- Vercel：免費方案即可（每月 100GB 流量）
- Anthropic API：每次掃描約 $0.002–0.005 USD
