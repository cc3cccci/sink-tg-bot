export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Only POST allowed', { status: 405 });
    }

    try {
      const payload = await request.json();
      if (!payload.message || !payload.message.text) {
        return new Response('OK');
      }

      const chatId = payload.message.chat.id;
      const text = payload.message.text.trim();
      const stateKey = `bot_state:${chatId}`;

      // 1. Check if cancel command
      if (text === '/cancel') {
        const stateData = await env.BOT_STATE.get(stateKey);
        if (stateData) {
          await env.BOT_STATE.delete(stateKey);
          await sendToTelegram(chatId, '🧹 *已取消当前操作*。会话已重置，您可以发送新指令。', env.TG_TOKEN);
        } else {
          await sendToTelegram(chatId, '❌ 您当前没有正在进行的操作。', env.TG_TOKEN);
        }
        return new Response('OK');
      }

      // 2. Fetch active session state from KV
      const stateData = await env.BOT_STATE.get(stateKey);
      let state = stateData ? JSON.parse(stateData) : null;

      // 3. If there is an active session, delegate to wizard handler
      if (state) {
        await handleWizardStep(chatId, text, state, stateKey, env);
        return new Response('OK');
      }

      // Help message & start command
      if (text === '/start' || text === '/help') {
        const welcomeMsg = `👋 您好！我是短链接助手。\n\n` +
          `*功能指令菜单*：\n` +
          `1. 🆕 *创建短链接*：\n` +
          `   • 发送 \`/add\` 开启分步配置向导\n` +
          `   • 直接发送长链接（如 \`https://example.com\`）快速创建\n` +
          `   • 格式：\`/shorten <长链接> [自定义别名]\`\n` +
          `2. 📄 *查看列表*：发送 \`/list\` 查看最近 10 条链接\n` +
          `3. ℹ️ *查询详情*：发送 \`/info <别名>\`\n` +
          `4. 🔧 *设置属性*：\n` +
          `   • 发送 \`/set\` 开启交互式修改向导\n` +
          `   • 格式：\`/set <别名> <属性> <值>\`\n` +
          `5. 🗑️ *删除链接*：发送 \`/delete <别名>\`\n\n` +
          `💬 提示：在分步向导中，您可以随时发送 \`/cancel\` 退出配置。`;
        await sendToTelegram(chatId, welcomeMsg, env.TG_TOKEN);
        return new Response('OK');
      }

      const parts = text.split(/\s+/);
      const command = parts[0].toLowerCase();

      // One-shot /shorten command
      if (command === '/shorten' || command === '/short') {
        const longUrl = parts[1];
        const customSlug = parts[2] || undefined;

        if (!longUrl) {
          // If no URL is provided, start the interactive wizard
          await env.BOT_STATE.put(stateKey, JSON.stringify({ type: 'ADD', step: 'AWAIT_URL' }));
          await sendToTelegram(chatId, '🆕 *开启分步创建短链接向导*\n\n第一步：请输入要缩短的 *目标长链接 (URL)*：', env.TG_TOKEN);
          return new Response('OK');
        }

        const result = await createShortLink(longUrl, customSlug, env);
        await sendToTelegram(chatId, result, env.TG_TOKEN);
      } 
      // Trigger interactive Add Link wizard via /add or /new
      else if (command === '/add' || command === '/new') {
        await env.BOT_STATE.put(stateKey, JSON.stringify({ type: 'ADD', step: 'AWAIT_URL' }));
        await sendToTelegram(chatId, '🆕 *开启分步创建短链接向导*\n\n第一步：请输入要缩短的 *目标长链接 (URL)*：', env.TG_TOKEN);
      }
      // One-shot or interactive /set command
      else if (command === '/set') {
        const slug = parts[1];
        const attr = parts[2];
        const val = parts[3];

        if (!slug || !attr || val === undefined) {
          // Trigger interactive Edit Link wizard
          await env.BOT_STATE.put(stateKey, JSON.stringify({ type: 'EDIT', step: 'EDIT_AWAIT_SLUG' }));
          await sendToTelegram(chatId, '🔧 *开启分步编辑属性向导*\n\n第一步：请输入要修改的短链接 *自定义别名 (Slug)*：', env.TG_TOKEN);
          return new Response('OK');
        }

        const result = await setLinkAttribute(slug, attr.toLowerCase(), val, env);
        await sendToTelegram(chatId, result, env.TG_TOKEN);
      }
      // Trigger /list
      else if (command === '/list') {
        const result = await listShortLinks(env);
        await sendToTelegram(chatId, result, env.TG_TOKEN);
      } 
      // Trigger /info
      else if (command === '/info') {
        const slug = parts[1];
        if (!slug) {
          await sendToTelegram(chatId, '❌ 请提供要查询的短链接别名。例如：\n`/info google-test`', env.TG_TOKEN);
          return new Response('OK');
        }
        const result = await queryLinkDetails(slug, env);
        await sendToTelegram(chatId, result, env.TG_TOKEN);
      } 
      // Trigger /delete
      else if (command === '/delete') {
        const slug = parts[1];
        if (!slug) {
          await sendToTelegram(chatId, '❌ 请提供要删除的短链接别名。例如：\n`/delete google-test`', env.TG_TOKEN);
          return new Response('OK');
        }
        const result = await deleteShortLink(slug, env);
        await sendToTelegram(chatId, result, env.TG_TOKEN);
      } 
      // Automatic URL Detection (trigger AWAIT_SLUG state)
      else {
        const urlPattern = /^(https?:\/\/[^\s]+)$/i;
        if (urlPattern.test(text)) {
          // Instead of instantly generating, guide user step-by-step
          await env.BOT_STATE.put(stateKey, JSON.stringify({ 
            type: 'ADD', 
            step: 'AWAIT_SLUG',
            url: text 
          }));
          await sendToTelegram(chatId, `🔗 *检测到长链接*：\`${text}\`\n\n已为您开启向导模式。第一步已完成。\n\n第二步：请输入您想要的 *自定义别名 (Slug)*：\n*(直接自动随机生成请发送 \`auto\` 或 \`/skip\`)*`, env.TG_TOKEN);
        } else {
          await sendToTelegram(chatId, '❓ 无法识别的指令。您可以发送一个长链接，或者发送 \`/help\` 查看指令指南。', env.TG_TOKEN);
        }
      }

    } catch (err) {
      console.error(err);
    }

    return new Response('OK');
  }
};

// Helper function to call Sink API using Service Binding (if available) or fallback to global fetch
function fetchSink(env, url, options) {
  if (env.SINK) {
    return env.SINK.fetch(url, options);
  }
  return fetch(url, options);
}

// 1. Call Sink API to create short link
async function createShortLink(longUrl, slug, env) {
  try {
    const response = await fetchSink(env, `${env.SINK_API_URL}/api/link/create`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SINK_SITE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: longUrl, slug: slug })
    });

    if (response.status === 201) {
      const data = await response.json();
      const shortUrl = `${env.SINK_API_URL}/${data.slug}`;
      return `✨ *生成成功！*\n\n🔗 缩短后链接：${shortUrl}\nℹ️ 查看详情：\n\`/info ${data.slug}\``;
    } else if (response.status === 409) {
      return `❌ 创建失败：自定义别名 \`${slug}\` 已存在，请换一个重试。`;
    } else {
      const errorText = await response.text();
      return `❌ 接口请求失败：${response.status}\n\`${errorText.slice(0, 100)}\``;
    }
  } catch (e) {
    return `❌ 无法连接到 Sink 短链接服务：${e.message}`;
  }
}

// 2. Call Sink API to list short links
async function listShortLinks(env) {
  try {
    const apiUrl = `${env.SINK_API_URL}/api/link/list?limit=10`;
    console.log("Fetching API URL via service binding:", apiUrl);
    const response = await fetchSink(env, apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${env.SINK_SITE_TOKEN}`
      }
    });
    console.log("Response status:", response.status, "statusText:", response.statusText);

    if (response.ok) {
      const data = await response.json();
      if (!data.links || data.links.length === 0) {
        return '📭 您目前还没有生成过短链接。';
      }

      let reply = `📄 *近期短链接列表 (最新 ${data.links.length} 条)*:\n\n`;
      data.links.forEach((link, index) => {
        const shortUrl = `${env.SINK_API_URL}/${link.slug}`;
        reply += `${index + 1}. \`${link.slug}\` ➜ [点击访问](${shortUrl})\n` +
                 `   └ 目标: \`${link.url.slice(0, 45)}${link.url.length > 45 ? '...' : ''}\`\n` +
                 `   └ 查询: \`/info ${link.slug}\`  |  删除: \`/delete ${link.slug}\`\n\n`;
      });
      return reply;
    } else {
      return `❌ 无法拉取链接列表：${response.statusText}`;
    }
  } catch (e) {
    return `❌ 请求异常：${e.message}`;
  }
}

// 3. Call Sink API to query link details
async function queryLinkDetails(slug, env) {
  try {
    const response = await fetchSink(env, `${env.SINK_API_URL}/api/link/query?slug=${encodeURIComponent(slug)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${env.SINK_SITE_TOKEN}`
      }
    });

    if (response.ok) {
      const link = await response.json();
      const shortUrl = `${env.SINK_API_URL}/${link.slug}`;
      const expiration = link.expiration ? new Date(link.expiration * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无限制';

      return `📊 *短链接详情 - ${link.slug}*\n\n` +
             `* 缩短地址: ${shortUrl}\n` +
             `* 目标链接: \`${link.url}\`\n` +
             `* 备注说明: \`${link.comment || '无'}\`\n` +
             `* 到期时间: \`${expiration}\`\n` +
             `* 密码保护: \`${link.password ? '已启用' : '未启用'}\`\n` +
             `* 页面掩饰 (Cloaking): \`${link.cloaking ? '已开启' : '未开启'}\`\n` +
             `* 重定向带参数 (Query): \`${link.redirectWithQuery ? '是' : '否'}\`\n` +
             `* 标注不安全: \`${link.unsafe ? '是' : '否'}\`\n\n` +
             `🔧 修改属性: \`/set ${link.slug} <属性> <值>\`\n` +
             `🗑️ 删除该链接: \`/delete ${link.slug}\``;
    } else if (response.status === 404) {
      return `❌ 未找到别名为 \`${slug}\` 的短链接。`;
    } else {
      return `❌ 查询失败：${response.statusText}`;
    }
  } catch (e) {
    return `❌ 请求异常：${e.message}`;
  }
}

// 4. Call Sink API to delete short link
async function deleteShortLink(slug, env) {
  try {
    const response = await fetchSink(env, `${env.SINK_API_URL}/api/link/delete`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SINK_SITE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ slug: slug })
    });

    if (response.ok) {
      return `🗑️ *删除成功*\n\n短链接 \`${slug}\` 已经被永久删除，对应的短地址已失效。`;
    } else if (response.status === 404) {
      return `❌ 删除失败：未找到别名为 \`${slug}\` 的短链接。`;
    } else {
      return `❌ 删除失败：${response.statusText}`;
    }
  } catch (e) {
    return `❌ 请求异常：${e.message}`;
  }
}

// 5. Call Sink API to update link attribute
async function setLinkAttribute(slug, attr, val, env) {
  try {
    // 1. Fetch existing link details
    const queryResponse = await fetchSink(env, `${env.SINK_API_URL}/api/link/query?slug=${encodeURIComponent(slug)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${env.SINK_SITE_TOKEN}`
      }
    });

    if (queryResponse.status === 404) {
      return `❌ 未找到别名为 \`${slug}\` 的短链接。`;
    } else if (!queryResponse.ok) {
      return `❌ 查询失败：${queryResponse.statusText}`;
    }

    const existingLink = await queryResponse.json();

    // 2. Prepare payload starting with existing fields to prevent deletion of unset fields
    const payload = {
      url: existingLink.url,
      slug: existingLink.slug,
      comment: existingLink.comment,
      expiration: existingLink.expiration,
      title: existingLink.title,
      description: existingLink.description,
      image: existingLink.image,
      apple: existingLink.apple,
      google: existingLink.google,
      cloaking: existingLink.cloaking,
      redirectWithQuery: existingLink.redirectWithQuery,
      unsafe: existingLink.unsafe,
      geo: existingLink.geo
    };

    let displayAttr = '';
    let displayVal = '';

    // 3. Process the attribute update
    if (attr === 'password' || attr === 'pass') {
      displayAttr = '密码保护';
      if (val.toLowerCase() === 'none' || val.toLowerCase() === 'clear') {
        payload.password = ''; // empty string deletes the password
        displayVal = '已清除';
      } else {
        payload.password = val;
        displayVal = `已设置为 \`${val}\``;
      }
    } else if (attr === 'cloaking' || attr === 'cloak') {
      displayAttr = '页面掩饰 (Cloaking)';
      if (val.toLowerCase() === 'true') {
        payload.cloaking = true;
        displayVal = '已开启';
      } else if (val.toLowerCase() === 'false') {
        payload.cloaking = false;
        displayVal = '已关闭';
      } else {
        return `❌ 属性值无效，页面掩饰只能设为 \`true\` 或 \`false\`。`;
      }
    } else if (attr === 'query') {
      displayAttr = '重定向带参数 (Query)';
      if (val.toLowerCase() === 'true') {
        payload.redirectWithQuery = true;
        displayVal = '是';
      } else if (val.toLowerCase() === 'false') {
        payload.redirectWithQuery = false;
        displayVal = '否';
      } else {
        return `❌ 属性值无效，重定向带参数只能设为 \`true\` 或 \`false\`。`;
      }
    } else if (attr === 'unsafe') {
      displayAttr = '标注不安全';
      if (val.toLowerCase() === 'true') {
        payload.unsafe = true;
        displayVal = '是';
      } else if (val.toLowerCase() === 'false') {
        payload.unsafe = false;
        displayVal = '否';
      } else {
        return `❌ 属性值无效，标注不安全只能设为 \`true\` 或 \`false\`。`;
      }
    } else {
      return `❌ 未知属性 \`${attr}\`。支持 the attributes: \`password\`、\`cloaking\`、\`query\`、\`unsafe\``;
    }

    // 4. Send PUT request to edit link
    const response = await fetchSink(env, `${env.SINK_API_URL}/api/link/edit`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.SINK_SITE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      return `✅ *属性修改成功！*\n\n短链接 \`${slug}\` 的 *${displayAttr}* ${displayVal}。`;
    } else {
      const errorText = await response.text();
      return `❌ 属性修改失败：${response.status}\n\`${errorText.slice(0, 100)}\``;
    }
  } catch (e) {
    return `❌ 请求异常：${e.message}`;
  }
}

// Interactive step-by-step wizard handler
async function handleWizardStep(chatId, text, state, stateKey, env) {
  if (state.type === 'ADD') {
    switch (state.step) {
      case 'AWAIT_URL': {
        const urlPattern = /^(https?:\/\/[^\s]+)$/i;
        if (!urlPattern.test(text)) {
          await sendToTelegram(chatId, '❌ 输入不符合 URL 格式。请重新输入正确的目标长链接 (例如 `https://example.com`):', env.TG_TOKEN);
          return;
        }
        state.url = text;
        state.step = 'AWAIT_SLUG';
        await env.BOT_STATE.put(stateKey, JSON.stringify(state));
        await sendToTelegram(chatId, '🔗 长链接录入成功！\n\n第二步：请输入您想要的 *自定义别名 (Slug)*：\n*(直接自动随机生成请发送 \`auto\` 或 \`/skip\`)*', env.TG_TOKEN);
        break;
      }

      case 'AWAIT_SLUG': {
        if (text !== 'auto' && text !== '/skip') {
          // Validate slug character format (alphanumeric and hyphens only)
          const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
          if (!slugRegex.test(text)) {
            await sendToTelegram(chatId, '❌ 别名格式错误。只能包含字母、数字和连字符（例如 `google-test`），请重新输入：', env.TG_TOKEN);
            return;
          }
          state.slug = text;
        }
        state.step = 'AWAIT_COMMENT';
        await env.BOT_STATE.put(stateKey, JSON.stringify(state));
        await sendToTelegram(chatId, '📝 别名已录入！\n\n第三步：请输入该链接的 *备注说明* (用于管理分类)：\n*(如果不设置备注，请发送 \`/skip\`)*', env.TG_TOKEN);
        break;
      }

      case 'AWAIT_COMMENT': {
        if (text !== '/skip') {
          state.comment = text;
        }
        state.step = 'AWAIT_PASSWORD';
        await env.BOT_STATE.put(stateKey, JSON.stringify(state));
        await sendToTelegram(chatId, '🔐 备注录入成功！\n\n第四步：是否需要为该链接配置访问 *密码保护*？\n\n• 如果需要，请输入您的*访问密码*\n• 如果不需要，请发送 \`/skip\`', env.TG_TOKEN);
        break;
      }

      case 'AWAIT_PASSWORD': {
        if (text !== '/skip') {
          state.password = text;
        }
        state.step = 'AWAIT_CLOAKING';
        await env.BOT_STATE.put(stateKey, JSON.stringify(state));
        await sendToTelegram(chatId, '🎨 密码设置录入成功！\n\n第五步：是否需要启用 *页面掩饰 (Cloaking)*？\n\n• 开启请输入 \`true\`\n• 关闭请回复 \`false\` 或发送 \`/skip\`', env.TG_TOKEN);
        break;
      }

      case 'AWAIT_CLOAKING': {
        if (text === 'true') {
          state.cloaking = true;
        } else {
          state.cloaking = false;
        }
        state.step = 'AWAIT_CONFIRM';
        await env.BOT_STATE.put(stateKey, JSON.stringify(state));

        const welcomeMsg = `🧐 *请核对以下设置并确认*：\n\n` +
          `• *目标网址*：\`${state.url}\`\n` +
          `• *自定义别名*：\`${state.slug || '（自动随机生成）'}\`\n` +
          `• *备注说明*：\`${state.comment || '（无备注）'}\`\n` +
          `• *访问密码*：\`${state.password ? '🔑 ' + state.password : '（无密码保护）'}\`\n` +
          `• *页面掩饰*：\`${state.cloaking ? '🎭 已开启' : '🚫 未启用'}\`\n\n` +
          `确认无误请发送 \`yes\` 或 \`/confirm\`，取消修改请发送 \`/cancel\`。`;
        await sendToTelegram(chatId, welcomeMsg, env.TG_TOKEN);
        break;
      }

      case 'AWAIT_CONFIRM': {
        if (text.toLowerCase() === 'yes' || text === '/confirm') {
          await sendToTelegram(chatId, '🚀 正在请求短链接系统生成链接...', env.TG_TOKEN);
          
          try {
            const response = await fetchSink(env, `${env.SINK_API_URL}/api/link/create`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.SINK_SITE_TOKEN}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                url: state.url,
                slug: state.slug,
                comment: state.comment,
                password: state.password,
                cloaking: state.cloaking
              })
            });

            if (response.status === 201) {
              const data = await response.json();
              const shortUrl = `${env.SINK_API_URL}/${data.slug}`;
              await sendToTelegram(chatId, `✨ *生成成功！*\n\n🔗 短网址：${shortUrl}\nℹ️ 查看详情：\n\`/info ${data.slug}\``, env.TG_TOKEN);
            } else if (response.status === 409) {
              await sendToTelegram(chatId, `❌ 创建失败：自定义别名 \`${state.slug}\` 已存在，请发送 \`/add\` 重新开始创建。`, env.TG_TOKEN);
            } else {
              const errorText = await response.text();
              await sendToTelegram(chatId, `❌ 接口请求失败：${response.status}\n\`${errorText.slice(0, 100)}\``, env.TG_TOKEN);
            }
          } catch (e) {
            await sendToTelegram(chatId, `❌ 无法连接到 Sink 短链接服务：${e.message}`, env.TG_TOKEN);
          } finally {
            await env.BOT_STATE.delete(stateKey);
          }
        } else {
          await sendToTelegram(chatId, '❓ 请发送 \`yes\` 或 \`/confirm\` 确认创建，或者发送 \`/cancel\` 放弃。', env.TG_TOKEN);
        }
        break;
      }
    }
  }

  else if (state.type === 'EDIT') {
    switch (state.step) {
      case 'EDIT_AWAIT_SLUG': {
        const slug = text;
        const queryResponse = await fetchSink(env, `${env.SINK_API_URL}/api/link/query?slug=${encodeURIComponent(slug)}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${env.SINK_SITE_TOKEN}`
          }
        });

        if (queryResponse.status === 404) {
          await sendToTelegram(chatId, `❌ 未找到别名为 \`${slug}\` 的短链接。请重新输入正确的别名：`, env.TG_TOKEN);
          return;
        } else if (!queryResponse.ok) {
          await sendToTelegram(chatId, `❌ 查询错误：${queryResponse.statusText}，请重试：`, env.TG_TOKEN);
          return;
        }

        const existingLink = await queryResponse.json();
        state.existingLink = existingLink;
        state.slug = slug;
        state.step = 'EDIT_AWAIT_ATTR';
        await env.BOT_STATE.put(stateKey, JSON.stringify(state));

        const welcomeMsg = `📊 *已找到短链接 \`${slug}\`*：\n` +
          `• 目标地址：\`${existingLink.url}\`\n\n` +
          `第二步：请回复您要修改的 *属性名称*（回复对应的英文关键字）：\n` +
          `• \`password\` - 访问密码\n` +
          `• \`cloaking\` - 页面掩饰\n` +
          `• \`query\` - 重定向带参数\n` +
          `• \`unsafe\` - 标记不安全`;
        await sendToTelegram(chatId, welcomeMsg, env.TG_TOKEN);
        break;
      }

      case 'EDIT_AWAIT_ATTR': {
        const attr = text.toLowerCase();
        if (attr === 'password' || attr === 'pass') {
          state.attr = 'password';
          state.displayAttr = '密码保护';
          state.step = 'EDIT_AWAIT_VAL';
          await env.BOT_STATE.put(stateKey, JSON.stringify(state));
          await sendToTelegram(chatId, `✏️ 您已选择修改 *密码保护*。\n\n第三步：请输入该属性的 *目标值*（输入具体密码，或回复 \`none\` 清除密码）：`, env.TG_TOKEN);
        } else if (attr === 'cloaking' || attr === 'cloak') {
          state.attr = 'cloaking';
          state.displayAttr = '页面掩饰 (Cloaking)';
          state.step = 'EDIT_AWAIT_VAL';
          await env.BOT_STATE.put(stateKey, JSON.stringify(state));
          await sendToTelegram(chatId, `✏️ 您已选择修改 *页面掩饰*。\n\n第三步：请回复该属性的 *目标值*：\n• 开启输入 \`true\`\n• 关闭输入 \`false\``, env.TG_TOKEN);
        } else if (attr === 'query') {
          state.attr = 'redirectWithQuery';
          state.displayAttr = '重定向带参数 (Query)';
          state.step = 'EDIT_AWAIT_VAL';
          await env.BOT_STATE.put(stateKey, JSON.stringify(state));
          await sendToTelegram(chatId, `✏️ 您已选择修改 *重定向带参数*。\n\n第三步：请回复该属性的 *目标值*：\n• 开启输入 \`true\`\n• 关闭输入 \`false\``, env.TG_TOKEN);
        } else if (attr === 'unsafe') {
          state.attr = 'unsafe';
          state.displayAttr = '标记不安全';
          state.step = 'EDIT_AWAIT_VAL';
          await env.BOT_STATE.put(stateKey, JSON.stringify(state));
          await sendToTelegram(chatId, `✏️ 您已选择修改 *标记不安全*。\n\n第三步：请回复该属性的 *目标值*：\n• 开启输入 \`true\`\n• 关闭输入 \`false\``, env.TG_TOKEN);
        } else {
          await sendToTelegram(chatId, '❌ 无法识别的属性。请输入以下四者之一：`password`、`cloaking`、`query`、`unsafe`', env.TG_TOKEN);
        }
        break;
      }

      case 'EDIT_AWAIT_VAL': {
        const val = text;
        const existingLink = state.existingLink;

        // Prepare full payload to prevent resetting other optional fields
        const payload = {
          url: existingLink.url,
          slug: existingLink.slug,
          comment: existingLink.comment,
          expiration: existingLink.expiration,
          title: existingLink.title,
          description: existingLink.description,
          image: existingLink.image,
          apple: existingLink.apple,
          google: existingLink.google,
          cloaking: existingLink.cloaking,
          redirectWithQuery: existingLink.redirectWithQuery,
          unsafe: existingLink.unsafe,
          geo: existingLink.geo
        };

        let displayVal = '';

        if (state.attr === 'password') {
          if (val.toLowerCase() === 'none' || val.toLowerCase() === 'clear') {
            payload.password = '';
            displayVal = '已清除';
          } else {
            payload.password = val;
            displayVal = `已设置为 \`${val}\``;
          }
        } else {
          // For boolean variables (cloaking, redirectWithQuery, unsafe)
          if (val.toLowerCase() === 'true') {
            payload[state.attr] = true;
            displayVal = '已开启/是';
          } else if (val.toLowerCase() === 'false') {
            payload[state.attr] = false;
            displayVal = '已关闭/否';
          } else {
            await sendToTelegram(chatId, '❌ 输入值无效，布尔属性值只能输入 `true` 或 `false`，请重新输入：', env.TG_TOKEN);
            return;
          }
        }

        await sendToTelegram(chatId, '🚀 正在提交属性修改...', env.TG_TOKEN);

        try {
          const response = await fetchSink(env, `${env.SINK_API_URL}/api/link/edit`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${env.SINK_SITE_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });

          if (response.ok) {
            await sendToTelegram(chatId, `✅ *属性修改成功！*\n\n短链接 \`${state.slug}\` 的 *${state.displayAttr}* ${displayVal}。`, env.TG_TOKEN);
          } else {
            const errorText = await response.text();
            await sendToTelegram(chatId, `❌ 属性修改失败：${response.status}\n\`${errorText.slice(0, 100)}\``, env.TG_TOKEN);
          }
        } catch (e) {
          await sendToTelegram(chatId, `❌ 请求异常：${e.message}`, env.TG_TOKEN);
        } finally {
          await env.BOT_STATE.delete(stateKey);
        }
        break;
      }
    }
  }
}

// Send message to Telegram
async function sendToTelegram(chatId, text, token) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    })
  });
}
