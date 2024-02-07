from io import BytesIO
from PIL import Image
import json
import random
import string
import sys
import cv2
import numpy as np
import pandas as pd
import math
import requests


def get_dx_median(dx, x, y, w, h):
    return np.median(dx[y:(y + h), x])


def pre_process(img_path):
    img = cv2.imread(img_path, 1)
    img_gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    _, binary = cv2.threshold(img_gray, 127, 255, cv2.THRESH_BINARY)

    contours, hierarchy = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)

    rect_area = []
    rect_arc_length = []
    cnt_infos = {}

    for i, cnt in enumerate(contours):
        if cv2.contourArea(cnt) < 5000 or cv2.contourArea(cnt) > 25000:
            continue

        x, y, w, h = cv2.boundingRect(cnt)
        cnt_infos[i] = {'rect_area': w * h,
                        'rect_arclength': 2 * (w + h),
                        'cnt_area': cv2.contourArea(cnt),
                        'cnt_arclength': cv2.arcLength(cnt, True),
                        'cnt': cnt,
                        'w': w,
                        'h': h,
                        'x': x,
                        'y': y,
                        'mean': np.mean(np.min(img[y:(y + h), x:(x + w)], axis=2)),
                        }
        rect_area.append(w * h)
        rect_arc_length.append(2 * (w + h))
    dx = cv2.Sobel(img, -1, 1, 0, ksize=5)

    return img, dx, cnt_infos


def tencent_mark_pos(img_path):
    img, dx, cnt_infos = pre_process(img_path)
    df = pd.DataFrame(cnt_infos).T
    df.head()
    df['dx_mean'] = df.apply(lambda x: get_dx_median(dx, x['x'], x['y'], x['w'], x['h']), axis=1)
    df['rect_ratio'] = df.apply(lambda v: v['rect_arclength'] / 4 / math.sqrt(v['rect_area'] + 1), axis=1)
    df['area_ratio'] = df.apply(lambda v: v['rect_area'] / v['cnt_area'], axis=1)
    df['score'] = df.apply(lambda x: abs(x['rect_ratio'] - 1), axis=1)

    result = df.query('x>0').query('area_ratio<2').query('rect_area>5000').query('rect_area<20000').sort_values(
        ['mean', 'score', 'dx_mean']).head(2)
    return result



def main():
    headers = {
        "Host": "t-captcha.gjacky.com",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
        "User-Agent": "Mozilla/5.0 (Linux; Android 7.1.2; SM-G955N Build/NRD90M.G955NKSU1AQDC; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/92.0.4515.131 Mobile Safari/537.36",
        "Accept": "*/*",
        "X-Requested-With": "com.tencent.ig",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Dest": "script",
        "Referer": "https://global.captcha.gtimg.com/",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Connection": "close"
    }
    
    data = json.loads(sys.argv[1])
    img_url = "https://t-captcha.gjacky.com" + data.get("data").get("dyn_show_info").get("bg_elem_cfg").get("img_url")
    
    proxies = {"http": sys.argv[2], "https": sys.argv[2]}
    r_img = requests.get(img_url, headers=headers, proxies=proxies)

    infile = Image.open(BytesIO(r_img.content))
    if infile.mode != 'RGB': infile = infile.convert('RGB')

    img_path = "./tmp/" + (''.join(random.choice(string.ascii_uppercase + string.digits) for _ in range(11))) + ".png"
    infile.save(img_path)

    res = tencent_mark_pos(img_path)
    dis = int((res.x.values[0] - 15) / 2) - 22
    print(dis)

if __name__ == "__main__":
    main()