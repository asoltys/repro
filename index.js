const fs = require("fs");
const { generateMnemonic, mnemonicToSeedSync } = require("bip39");
const { fromSeed } = require("bip32");
const { fromBase58 } = require("bip32");
const {
  address: Address,
  confidential,
  ECPair,
  Psbt,
  payments,
  networks,
  Transaction,
} = require("liquidjs-lib");
const { Buffer } = require("buffer");
const reverse = require("buffer-reverse");
const { fromSeed: slip77 } = require("slip77");
const wretch = require("wretch");
const fetch = require("node-fetch");
wretch().polyfills({ fetch });
const liquid = wretch().url("http://admin1:123@localhost:7045");
const electrs = wretch().url("http://localhost:3012");
const nonWitnessUtxoBuffer = require("./utxo");
const network = networks.regtest;
const nonce = Buffer.from("00", "hex");
const MNEMONIC =
  "settle anxiety sport cluster media unveil honey topple absent puppy divorce mosquito";
const randomIndex = Math.floor(Math.random() * 100000);

const alice = ECPair.fromWIF(
  "cPNMJD4VyFnQjGbGs3kcydRzAbDCXrLAbvH6wTCqs88qg1SkZT3J",
  network
);
const bob = ECPair.fromWIF(
  "cQ7z41awTvKtmiD9p6zkjbgvYbV8g5EDDNcTnKZS9aZ8XdjQiZMU",
  network
);
const asset = Buffer.concat([
  Buffer.from("01", "hex"),
  Buffer.from(network.assetHash, "hex").reverse(),
]);

const BTC = "5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225";
const DUST = 1000;
const FEE = 300;

const singleAnyoneCanPay =
  Transaction.SIGHASH_SINGLE | Transaction.SIGHASH_ANYONECANPAY;
const noneAnyoneCanPay =
  Transaction.SIGHASH_NONE | Transaction.SIGHASH_ANYONECANPAY;

const keypair = (mnemonic, pass) => {
  mnemonic = MNEMONIC;

  try {
    let seed = mnemonicToSeedSync(mnemonic);
    let key = fromSeed(seed, network).derivePath(
      `m/84'/0'/0'/0/${randomIndex}`
    );
    let { publicKey: pubkey, privateKey: privkey } = key;
    let base58 = key.neutered().toBase58();

    return { pubkey, privkey, seed, base58 };
  } catch (e) {
    throw new Error("Failed to generated keys with mnemonic");
  }
};

const p2wpkh = (key) => {
  if (!key) key = keypair();
  let { pubkey, seed } = key;

  let redeem = payments.p2wpkh({
    pubkey,
    network,
  });

  let blindkey;
  try {
    blindkey = blindingKey(key).publicKey;
  } catch (e) {
    console.log("blindkey fail", e);
  }

  return payments.p2sh({
    redeem,
    network,
    blindkey,
  });
};

const blindingKey = (key) => {
  if (!key) key = keypair();
  let { pubkey, seed } = key;

  let redeem = payments.p2wpkh({
    pubkey,
    network,
  });

  return slip77(seed).derive(redeem.output);
};

const sign = (p, sighash = 1) => {
  let { privkey } = keypair();

  p.data.inputs.map((_, i) => {
    try {
      p = p
        .signInput(i, ECPair.fromPrivateKey(privkey), [sighash])
        .finalizeInput(i);
    } catch (e) {
      // console.log("failed to sign", e.message, i, sighash);
    }
  });

  return p;
};

const broadcast = async (p) => {
  let tx = p.extractTransaction();
  let hex = tx.toHex();
  console.log("Writing tx hex to ./hex");
  fs.writeFileSync("hex", hex);

  return electrs.url("/tx").body(hex).post().text();
};

const createIssuance = async () => {
  let out = p2wpkh();

  let address = getAddress();
  let utxos = await electrs.url(`/address/${address}/utxo`).get().json();

  let hex = await getHex(utxos[0].txid);
  let prevOut = await Transaction.fromHex(hex);

  let p = new Psbt()
    .addInput({
      hash: prevOut.getId(),
      index: utxos[0].vout,
      redeemScript: p2wpkh().redeem.output,
      nonWitnessUtxo: Buffer.from(hex, "hex"),
    })
    .addIssuance({
      assetAmount: 1,
      assetAddress: out.address,
      tokenAmount: 0,
      precision: 0,
      net: network,
    })
    .addOutputs([
      {
        asset: BTC,
        nonce,
        script: out.output,
        value: 100000000 - FEE,
      },
      {
        asset: BTC,
        nonce,
        script: Buffer.alloc(0),
        value: FEE,
      },
    ]);

  p = await p.blindOutputs(
    [blindingKey().privateKey],
    [...Array(p.data.outputs.length - 1)].map(() => blindingKey().publicKey)
  );

  p = sign(p);

  await broadcast(p);
};

const getAddress = () => {
  return p2wpkh().confidentialAddress;
};

const getHex = async (txid) => {
  return electrs.url(`/tx/${txid}/hex`).get().text();
};

const main = async () => {
  try {
    let addr = getAddress();

    console.log("Sending 1 BTC to", addr);

    let { result: tx } = await liquid
      .post({
        method: "sendtoaddress",
        params: [addr, 1],
      })
      .json();

    console.log("Mining a block");

    await liquid
      .post({
        method: "generatetoaddress",
        params: [1, "XFkbKaC8HKcgwMPVD5Zq3Tktio74dzMzi7"],
      })
      .json();

    console.log("Importing blinding key");

    await liquid
      .post({
        method: "importblindingkey",
        params: [getAddress(), blindingKey().privateKey.toString("hex")],
      })
      .json();

    console.log("Waiting 5s for electrs to warm up");

    await new Promise((r) => setTimeout(r, 5000));

    console.log("Creating issuance tx");

    await createIssuance();
  } catch (e) {
    console.log(e);
  }
};

main();
