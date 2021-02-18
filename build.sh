#!/bin/bash

npm run increase_version
rm -f nclient-lib*.tgz
npm pack
cp nclient-lib-*.tgz nclient-lib.tgz
curl -F "file=@./nclient-lib.tgz" http://159.69.2.203:3030/upload
