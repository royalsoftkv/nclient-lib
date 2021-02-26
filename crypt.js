const crypto = require("crypto");

const encrypt = function(toEncrypt, publicKey) {
    var buffer = Buffer.from(toEncrypt);
    var encrypted = crypto.publicEncrypt(publicKey, buffer);
    return encrypted.toString("base64");
};

const decrypt = function(toDecrypt, privateKey, passphrase='') {
    var buffer = Buffer.from(toDecrypt, "base64");
    const decrypted = crypto.privateDecrypt(
        {
            key: privateKey.toString(),
            passphrase: passphrase,
        },
        buffer,
    )
    return decrypted.toString("utf8");
};

module.exports = {
    encrypt,
    decrypt,
    generateKeys
}

const { generateKeyPairSync } = require('crypto')

function generateKeys(passphrase='') {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 4096,
        publicKeyEncoding: {
            type: 'pkcs1',
            format: 'pem',
        },
        privateKeyEncoding: {
            type: 'pkcs1',
            format: 'pem',
            cipher: 'aes-256-cbc',
            passphrase: passphrase,
        },
    })
    return { privateKey, publicKey }
}
