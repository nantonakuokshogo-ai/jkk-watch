name: jkk-watch

on:
  workflow_dispatch:
  schedule:
    - cron: "0 * * * *" # 毎時0分（好みで調整OK）

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      # Chrome を用意（出力に chrome-path が入ります）
      - uses: browser-actions/setup-chrome@v1
        id: chrome

      - name: Install
        run: npm i --no-fund --no-audit

      - name: Monitor
        env:
          CHROME_PATH: ${{ steps.chrome.outputs.chrome-path }}
        run: npm run monitor

      - name: Upload
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: out
          path: out/**
