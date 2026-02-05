export async function onRequest(context) {
    const { request, env, params } = context;
    const url = new URL(request.url);

    let fileUrl = 'https://telegra.ph/' + url.pathname + url.search;

    // 如果是 Telegram Bot API 上传的文件（路径较长）
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

    if (!response.ok) return response;

    // Admin 页面允许直接查看
    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`);
    if (isAdmin) return forceMediaInline(response, fileUrl);

    // KV 未初始化，直接返回文件（但也尝试按图片/视频 inline）
    if (!env.img_url) return forceMediaInline(response, fileUrl);

    // 获取 KV metadata
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

    // 白名单直接显示
    if (metadata.ListType === "White") {
        return forceMediaInline(response, fileUrl);
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

    // 强制图片/视频 inline 返回（其它类型保持原样，让浏览器决定）
    return forceMediaInline(response, fileUrl);
}


// -------------------------
// 强制图片/视频显示，其他文件默认浏览器处理
// -------------------------
function forceMediaInline(originalResponse, fileUrl) {
    const newHeaders = new Headers(originalResponse.headers);

    // 先尝试通过 URL 后缀判断类型
    const lower = fileUrl.toLowerCase();
    let determinedContentType = null;

    // 图片类型
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) determinedContentType = "image/jpeg";
    else if (lower.endsWith(".png")) determinedContentType = "image/png";
    else if (lower.endsWith(".gif")) determinedContentType = "image/gif";
    else if (lower.endsWith(".webp")) determinedContentType = "image/webp";
    else if (lower.endsWith(".bmp")) determinedContentType = "image/bmp";
    else if (lower.endsWith(".svg")) determinedContentType = "image/svg+xml";

    // 常见视频类型
    else if (lower.endsWith(".mp4")) determinedContentType = "video/mp4";
    else if (lower.endsWith(".webm")) determinedContentType = "video/webm";
    else if (lower.endsWith(".ogv") || lower.endsWith(".ogg")) determinedContentType = "video/ogg";
    else if (lower.endsWith(".mov")) determinedContentType = "video/quicktime";
    else if (lower.endsWith(".mkv")) determinedContentType = "video/x-matroska";
    else if (lower.endsWith(".flv")) determinedContentType = "video/x-flv";
    else if (lower.endsWith(".ts")) determinedContentType = "video/mp2t";

    // 如果 URL 后缀无法判断，则回退使用原始响应头的 Content-Type（如果有）
    if (!determinedContentType) {
        const originCT = originalResponse.headers.get("Content-Type");
        if (originCT) {
            // 只接受 image/ 或 video/ 类型作为 inline 判定依据
            if (originCT.startsWith("image/") || originCT.startsWith("video/")) {
                determinedContentType = originCT.split(";")[0]; // 去掉 charset 等参数
            }
        }
    }

    // 如果确定是 image/ 或 video/，则设置 Content-Type 并强制 inline
    if (determinedContentType) {
        newHeaders.set("Content-Type", determinedContentType);

        if (determinedContentType.startsWith("image/") || determinedContentType.startsWith("video/")) {
            newHeaders.set("Content-Disposition", "inline");
        }
    }

    // 返回新的 Response，保留原始状态码和 body（支持 Range 等）
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
