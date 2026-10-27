/**
 * 英語ネイティブ音声メーカー（ondoku.html）用 写真読み取りサーバー（Google Apps Script）
 *
 * 使い方
 *   1. Apps Script のエディタで「コード.gs」の中身を、このファイルの内容に置き換えて保存
 *   2. スクリプト プロパティ GEMINI_API_KEY に Gemini API キーを設定（設定済みならそのまま）
 *   3. 「デプロイ」→「デプロイを管理」→ 鉛筆（編集）→ バージョン「新バージョン」→「デプロイ」
 *      ※ 新バージョンでデプロイし直さないと、公開中のURLには反映されません
 *      ※ URL は変わらないので、ondoku.html の GAS_OCR_URL はそのままで大丈夫です
 *
 * 以前の版からの主な変更
 *   - 試すモデルを最大3つ（速い flash 系のみ）に絞り、pro 系など遅いモデルは使わない
 *   - 全体で 50 秒を超えたら次のモデルを試さずに打ち切る（GAS の 6 分制限で固まらない）
 *   - Gemini の「考える時間」を短くして、読み取りを速くする
 *   - 使えるモデル一覧を 6 時間キャッシュして、毎回の問い合わせを省く
 */

const TIME_BUDGET_MS = 50 * 1000;   // これを超えたら次のモデルは試さない
const MAX_MODELS = 3;               // 試すモデルの最大数

/** 【動作確認用】エディタで testConnection を選んで「▷ 実行」 */
function testConnection() {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('❌ GEMINI_API_KEY が設定されていません。');
  CacheService.getScriptCache().remove('gemini_models');
  const models = getCandidateModels(apiKey);
  Logger.log('試すモデル: ' + models.join(', '));
  const t0 = Date.now();
  const res = callGeminiWithFallback(apiKey, { contents: [{ parts: [{ text: 'Reply with only the word: OK' }] }] });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (res.ok) Logger.log('🎉 テスト成功（' + res.model + '・' + sec + '秒）応答: ' + res.text);
  else throw new Error('❌ APIエラー（' + sec + '秒）: ' + res.error);
}

/** ondoku.html から画像を受け取り、英文を返す */
function doPost(e) {
  const t0 = Date.now();
  try {
    const apiKey = getApiKey();
    if (!apiKey) return createJsonResponse({ error: 'GAS側に GEMINI_API_KEY が設定されていません。' });

    const params = JSON.parse(e.postData.contents);
    const base64Image = params.image;
    const fixSpelling = Boolean(params.fixSpelling);
    if (!base64Image) return createJsonResponse({ error: '画像データが空です。' });

    const spellInstruction = fixSpelling
      ? "4. Correct obvious handwritten spelling mistakes (e.g., 'peacefull' -> 'peaceful') so that it can be read naturally by Text-to-Speech."
      : "4. Keep the student's original words as written, only fixing obvious letter-recognition ambiguities based on context.";

    const prompt = [
      'You are an expert OCR assistant for English education.',
      'Transcribe the English sentences written in this image (especially student handwriting on lined worksheets).',
      'Rules:',
      "1. Ignore worksheet headers (like 'Organize your ideas', 'Rewrite', 'Step 3'), illustrations, Japanese text, teacher stamps, or page numbers.",
      '2. Output ONLY the transcribed English body text.',
      '3. Join line breaks within the same paragraph into natural continuous sentences.',
      spellInstruction,
      '5. Do NOT add markdown, explanations, or introductory phrases.'
    ].join('\n');

    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
        ]
      }],
      generationConfig: { temperature: 0.0 }
    };

    const result = callGeminiWithFallback(apiKey, payload, t0);
    const sec = Math.round((Date.now() - t0) / 100) / 10;
    if (result.ok) return createJsonResponse({ text: result.text, model: result.model, seconds: sec });
    return createJsonResponse({ error: 'Gemini APIエラー: ' + result.error, seconds: sec });
  } catch (err) {
    return createJsonResponse({ error: 'サーバー処理エラー: ' + String(err && err.message || err) });
  }
}

function getApiKey() {
  return (PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '').trim();
}

/** 混雑やエラーのときは次のモデルへ。ただし全体の時間を区切って、固まらないようにする */
function callGeminiWithFallback(apiKey, payload, startedAt) {
  const t0 = startedAt || Date.now();
  const models = getCandidateModels(apiKey);
  const errors = [];

  for (let i = 0; i < models.length; i++) {
    if (i > 0 && Date.now() - t0 > TIME_BUDGET_MS) {
      errors.push('時間切れのため打ち切り');
      break;
    }
    const res = callSingleModel(models[i], apiKey, payload);
    if (res.ok) return { ok: true, text: res.text, model: models[i] };
    errors.push(models[i].replace('models/', '') + ': ' + res.error);
    // APIキーの誤りなど、どのモデルでも同じ結果になるエラーはすぐにやめる
    if (res.status === 400 && /API key|API_KEY/i.test(res.error)) break;
    if (res.status === 403) break;
  }
  return { ok: false, error: errors.join(' / ') };
}

/** 1つのモデルに問い合わせる。「考える時間」を短くして速くする（未対応のモデルなら外してやり直す） */
function callSingleModel(modelPath, apiKey, payload) {
  const fast = JSON.parse(JSON.stringify(payload));
  fast.generationConfig = Object.assign({}, fast.generationConfig, { thinkingConfig: { thinkingLevel: 'low' } });
  let res = fetchModel(modelPath, apiKey, fast);
  if (!res.ok && res.status === 400 && /thinking/i.test(res.error)) {
    res = fetchModel(modelPath, apiKey, payload);
  }
  return res;
}

function fetchModel(modelPath, apiKey, payload) {
  const cleanPath = modelPath.indexOf('models/') === 0 ? modelPath : 'models/' + modelPath;
  const url = 'https://generativelanguage.googleapis.com/v1beta/' + cleanPath + ':generateContent?key=' + encodeURIComponent(apiKey);
  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    return { ok: false, error: '通信エラー: ' + String(err && err.message || err), status: 0 };
  }

  const status = res.getResponseCode();
  let json = {};
  try { json = JSON.parse(res.getContentText() || '{}'); } catch (e) { /* JSON 以外が返ってきた */ }

  if (status === 200) {
    const cand = (json.candidates && json.candidates[0]) || {};
    const parts = (cand.content && cand.content.parts) || [];
    const text = parts.filter(function (p) { return !p.thought; })
      .map(function (p) { return p.text || ''; }).join('').trim();
    if (text) return { ok: true, text: text, status: 200 };
    const why = cand.finishReason || (json.promptFeedback && json.promptFeedback.blockReason) || '空の応答';
    return { ok: false, error: '画像から英文を読み取れませんでした（' + why + '）', status: 200 };
  }

  const errMsg = (json.error && json.error.message) ? json.error.message : ('HTTP ' + status);
  return { ok: false, error: errMsg, status: status };
}

/** 使えるモデルの中から、速い flash 系を最大3つ選ぶ（結果は6時間キャッシュ） */
function getCandidateModels(apiKey) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('gemini_models');
  if (cached) return JSON.parse(cached);

  const defaultList = ['models/gemini-3.8-flash', 'models/gemini-3.8-flash-lite', 'models/gemini-3.6-flash'];
  let list = defaultList;
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(apiKey);
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      const names = (JSON.parse(res.getContentText() || '{}').models || []).filter(function (m) {
        const methods = m.supportedGenerationMethods || [];
        return methods.indexOf('generateContent') !== -1 &&
          /gemini-\d/i.test(m.name) && /flash/i.test(m.name) &&
          !/embedding|image|veo|tts|audio|live|learnlm|thinking|exp|preview|-\d{3}$|gemini-1\.|gemini-2\./i.test(m.name);
      }).map(function (m) { return m.name; });

      // バージョンの新しい順。同じバージョンなら flash → flash-lite の順
      const ver = function (n) { const m = n.match(/gemini-(\d+(?:\.\d+)?)/i); return m ? parseFloat(m[1]) : 0; };
      names.sort(function (a, b) {
        return (ver(b) - ver(a)) || ((/lite/i.test(a) ? 1 : 0) - (/lite/i.test(b) ? 1 : 0)) || a.length - b.length;
      });
      if (names.length) list = names.slice(0, MAX_MODELS);
    }
  } catch (e) { /* 一覧が取れなければ既定のリストを使う */ }

  cache.put('gemini_models', JSON.stringify(list), 6 * 60 * 60);
  return list;
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
