export async function onRequest(context) {
    const { request, env, params } = context;
    const url = new URL(request.url);

    let fileUrl = 'https://telegra.ph/' + url.pathname + url.search;

    // 判断是否是 Telegram Bot API 上传的文件（路径较长）
    if (url.pathname.length > 39) {
        const fileId = url.pathname.split(".")[0].split("/")[2];
        const filePath = await getFilePath(env, fileId);
        if (filePath) {
            fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
        }
    }

    // 请求文件
    const response = await fetch(fileUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
    });

    if (!response.ok) return fixResponse(response, request.url);

    // Admin 页面允许直接查看
    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`);
    if (isAdmin) return fixResponse(response, request.url);

    // KV 未初始化，直接返回文件
    if (!env.img_url) return fixResponse(response, request.url);

    // 从 KV 获取 metadata
    let record = await env.img_url.getWithMetadata(params.id);
    if (!record || !record.metadata) {
        record = {
            metadata: {
                ListType: "None",
                Label: "None",
                TimeStamp: Date.now(),
                liked: false,
                fileName: params.id,
                fileSize: 0,
            }
        };
        await env.img_url.put(params.id, "", { metadata: record.metadata });
    }

    const metadata = {
        ListType: record.metadata.ListType || "None",
        Label: record.metadata.Label || "None",
        TimeStamp: record.metadata.TimeStamp || Date.now(),
        liked: record.metadata.liked !== undefined ? record.metadata.liked : false,
        fileName: record.metadata.fileName || params.id,
        fileSize: record.metadata.fileSize || 0,
    };

    // 白名单：直接显示
    if (metadata.ListType === "White") {
        return fixResponse(response, request.url);
    }

    // 黑名单 / 成人内容 → 拦截
    if (metadata.ListType === "Block" || metadata.Label === "adult") {
        const referer = request.headers.get('Referer');
        const redirectUrl = referer
            ? "https://static-res.pages.dev/teleimage/img-block-compressed.png"
            : `${url.origin}/block-img.html`;
        return Response.redirect(redirectUrl, 302);
    }

    // 白名单模式开启 → 不允许公开访问
    if (env.WhiteList_Mode === "true") {
        return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
    }

    // 内容审核
    if (env.ModerateContentApiKey) {
        try {
            const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=https://telegra.ph${url.pathname}${url.search}`;
            const moderateResponse = await fetch(moderateUrl);
            if (moderateResponse.ok) {
                const moderateData = await moderateResponse.json();
                if (moderateData?.rating_label) {
                    metadata.Label = moderateData.rating_label;
                    if (moderateData.rating_label === "adult") {
                        await env.img_url.put(params.id, "", { metadata });
                        return Response.redirect(`${url.origin}/block-img.html`, 302);
                    }
                }
            }
        } catch (error) {
            console.error("Moderation error:", error.message);
        }
    }

    // 保存 metadata
    await env.img_url.put(params.id, "", { metadata });

    // 最终返回响应，区分显示 / 下载
    return fixResponse(response, request.url);
}


// -------------------------
// 根据文件类型判断是否 inline（直接显示）还是 attachment（下载）
// -------------------------
function fixResponse(originalResponse, requestUrl) {
    const newHeaders = new Headers(originalResponse.headers);

    const contentType = originalResponse.headers.get("Content-Type") || "application/octet-stream";

    // 根据扩展名 + MIME 类型判断
    const inlineExts = ['jpg','jpeg','png','gif','webp','bmp','tiff','mp4','webm','mov','mkv','avi','mp3','wav','ogg','m4a'];
    const pathname = new URL(requestUrl).pathname.toLowerCase();

    let disposition = "attachment"; // 默认下载

    // 扩展名判断
    for (const ext of inlineExts) {
        if (pathname.endsWith('.' + ext)) {
            disposition = "inline";
            break;
        }
    }

    // MIME 类型判断
    if (disposition !== "inline" && (contentType.startsWith("image/") || contentType.startsWith("video/") || contentType.startsWith("audio/"))) {
        disposition = "inline";
    }

    newHeaders.set("Content-Disposition", disposition);

    // 修复 Telegram 有时返回的错误 Content-Type
    if (disposition === "inline" && !contentType.startsWith("image/") && !contentType.startsWith("video/") && !contentType.startsWith("audio/")) {
        newHeaders.set("Content-Type", "application/octet-stream");
    }

    return new Response(originalResponse.body, {
        status: originalResponse.status,
        statusText: originalResponse.statusText,
        headers: newHeaders
    });
}


// -------------------------
// 获取 Telegram 文件路径
// -------------------------
async function getFilePath(env, file_id) {
    try {
        const res = await fetch(`https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`, { method: 'GET' });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.ok && data.result) return data.result.file_path;
        return null;
    } catch (error) {
        console.error("getFilePath error:", error.message);
        return null;
    }
}
