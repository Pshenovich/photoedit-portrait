# PhotoEdit Pro

Портретный редактор в браузере (MediaPipe Face Landmarker). Статика, без сборки.

## Уже развёрнуто

| Где | URL |
|-----|-----|
| Репозиторий | https://github.com/Pshenovich/photoedit-portrait |
| **Vercel** (основной прод) | https://photoedit-portrait.vercel.app |
| **GitHub Pages** (зеркало) | https://pshenovich.github.io/photoedit-portrait/ |

Оба варианта отдают тот же `index.html` по HTTPS.

## Авто-деплой Vercel (прод)

Каждый **`git push` в `main`** запускает GitHub Actions [`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml) и выкладывает на **https://photoedit-portrait.vercel.app**.

Секреты в репозитории: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

Ручной прод с машины (если CI не нужен):

```bash
./scripts/deploy-prod.sh
```

Или вручную:

```bash
NPM_CONFIG_CACHE=/tmp/npm-cache-photoedit npx vercel@latest deploy --prod --yes
```

Проект Vercel: `knazorlov-6551s-projects/photoedit-portrait` (аккаунт CLI на этой машине).

## GitHub Pages

Страницы включены с ветки `main`, путь `/`. Обновление после push может занять 1–2 минуты.

## Локально

```bash
python3 -m http.server 8080
```

Для **ИИ (CometAPI)** нужен деплой на Vercel (или `vercel dev`), а не чистая статика: функция `api/comet-edit.js` проксирует запрос на `https://api.cometapi.com/v1/images/edits`.

1. В проекте Vercel: **Settings → Environment Variables** → `COMET_API_KEY` = ваш ключ с [CometAPI](https://apidoc.cometapi.com).
2. Локально: `vercel dev` в корне репозитория с тем же ключом в `.env` или в окружении.

Без ключа кнопка «ИИ улучшить» вернёт сообщение об отсутствии `COMET_API_KEY`.

## Заметки

- Первый визит тянет WASM/модель MediaPipe из сети.
- Выбор фото с устройства — только по **HTTPS** или `localhost` (продакшен это удовлетворяет).
