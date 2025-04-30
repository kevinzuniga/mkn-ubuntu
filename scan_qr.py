#!/usr/bin/env python3
from pyzbar.pyzbar import decode # type: ignore
from PIL import Image # type: ignore
import sys

img = Image.open(sys.argv[1])
result = decode(img)
if result:
    print(result[0].data.decode())