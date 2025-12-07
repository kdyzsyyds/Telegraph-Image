export async function onRequest(context) {
    const { request, env, params } = context;
    const url = new URL(request.url);

    let fileUrl = 'https://telegra.ph/' + url.pathname + url.search;

    if (url.pathname.length > 39) { // Telegram Bot API 上传的文件
        const fileId = url.pathname.split(".")[0].split("/")[2];
        const filePath = await getFilePath(env, fileId);
        if (filePath) {
            fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
        }
    }

    // 原始 fetch 请求
    const response = await fetch(fileUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
    });

    if (!response.ok) return response;

    // Admin 页面直接返回原始内容
    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`);
    if (isAdmin) return response;

    // KV 存储检查和初始化
    let record;
    if (env.img_url) {
        record = await env.img_url.getWithMetadata(params.id);
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
    }

    const metadata = record?.metadata || {
        ListType: "None",
        Label: "None",
        TimeStamp: Date.now(),
        liked: false,
        fileName: params.id,
        fileSize: 0,
    };

    // 白名单/屏蔽逻辑
    if (metadata.ListType === "White") {
        return modifyResponse(response);
    } else if (metadata.ListType === "Block" || metadata.Label === "adult") {
        const referer = request.headers.get('Referer');
        const redirectUrl = referer ? "https://static-res.pages.dev/teleimage/img-block-compressed.png" : `${url.origin}/block-img.html`;
        return Response.redirect(redirectUrl, 302);
    }

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
            console.error("Content moderation error:", error.message);
        }
    }

    // 保存 metadata
    if (env.img_url) {
        await env.img_url.put(params.id, "", { metadata });
    }

    // 返回响应，并根据类型设置 Content-Disposition
    return modifyResponse(response);
}

// 将 response 修改为 inline 或 attachment
async function modifyResponse(response) {
    const contentType = response.headers.get("Content-Type") || "application/octet-stream";
    let disposition = "attachment"; // 默认下载
    if (contentType.startsWith("image/") || contentType.startsWith("video/") || contentType.startsWith("audio/")) {
        disposition = "inline"; // 直接显示
    }

    const modifiedHeaders = new Headers(response.headers);
    modifiedHeaders.set("Content-Disposition", disposition);

    const body = await response.arrayBuffer();
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: modifiedHeaders
    });
}

// 获取 Telegram 文件路径
async function getFilePath(env, file_id) {
    try {
        const res = await fetch(`https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.ok && data.result) return data.result.file_path;
        return null;
    } catch (error) {
        console.error('getFilePath error:', error.message);
        return null;
    }
}

