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
    if (isAdmin) return forceImageInline(response, fileUrl);

    // KV 未初始化，直接返回文件
    if (!env.img_url) return forceImageInline(response, fileUrl);

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
        return forceImageInline(response, fileUrl);
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

    // 强制图片 inline 返回
    return forceImageInline(response, fileUrl);
}


// -------------------------
// 强制图片显示，其他文件默认浏览器处理
// -------------------------
function forceImageInline(originalResponse, fileUrl) {
    const newHeaders = new Headers(originalResponse.headers);

    // 根据文件后缀判断是否图片
    const lower = fileUrl.toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) newHeaders.set("Content-Type", "image/jpeg");
    else if (lower.endsWith(".png")) newHeaders.set("Content-Type", "image/png");
    else if (lower.endsWith(".gif")) newHeaders.set("Content-Type", "image/gif");
    else if (lower.endsWith(".webp")) newHeaders.set("Content-Type", "image/webp");
    else if (lower.endsWith(".bmp")) newHeaders.set("Content-Type", "image/bmp");

    // 只针对图片强制 inline
    if (newHeaders.get("Content-Type")?.startsWith("image/")) {
        newHeaders.set("Content-Disposition", "inline");
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
