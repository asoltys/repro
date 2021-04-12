const fs = require("fs");
const { mnemonicToSeedSync } = require("bip39");
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
} = require("@asoltys/liquidjs-lib");
const { Buffer } = require("buffer");
const reverse = require("buffer-reverse");
const { fromSeed: slip77 } = require("slip77");
const wretch = require("wretch");
const fetch = require("node-fetch");
wretch().polyfills({ fetch });
const liquid = wretch().url("http://admin1:123@localhost:7045");
const electrs = wretch().url("http://localhost:3012");

const BTC = "5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225";
const DUST = 1000;
const FEE = 300;

const network = networks.regtest;
const singleAnyoneCanPay =
  Transaction.SIGHASH_SINGLE | Transaction.SIGHASH_ANYONECANPAY;
const noneAnyoneCanPay =
  Transaction.SIGHASH_NONE | Transaction.SIGHASH_ANYONECANPAY;

const faucet = async (addr) => {
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

  console.log("Waiting 10s for electrs to warm up");
  await new Promise((r) => setTimeout(r, 10000));

  return tx;
};

const unblind = (output) =>
  confidential.unblindOutputWithKey(output, blindingKey().privateKey);

const keypair = (mnemonic, pass) => {
  mnemonic =
    "garbage acid outside pave steel plastic car business keep vocal connect include";

  try {
    let seed = mnemonicToSeedSync(mnemonic);
    let key = fromSeed(seed, network).derivePath("m/84'/0'/0'/0/0");
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
  } catch (e) {}

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

function shuffle(array) {
  var currentIndex = array.length,
    temporaryValue,
    randomIndex;

  while (0 !== currentIndex) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex -= 1;

    temporaryValue = array[currentIndex];
    array[currentIndex] = array[randomIndex];
    array[randomIndex] = temporaryValue;
  }

  return array;
}

let outputsToBlind = [];
const fund = async (
  p,
  out,
  asset,
  amount,
  sighashType = 1,
) => {
  let { address, redeem, output } = out;

  let unblinded = {};
  let utxos = await electrs.url(`/address/${address}/utxo`).get().json();
  for (let i = 0; i < utxos.length; i++) {
    if (utxos[i].asset) continue;
    let { txid, vout } = utxos[i];
    if (!unblinded[txid]) {
      let tx = await getTx(txid);
      try {
        let unblinded = await unblind(tx.outs[vout]);
        let {
          asset,
          value,
          assetBlindingFactor,
          valueBlindingFactor,
        } = unblinded;
        utxos[i].asset = reverse(asset).toString("hex");
        utxos[i].value = parseInt(value);
        utxos[i].assetBuffer = asset;
        utxos[i].valueString = value;
        utxos[i].assetBlindingFactor = assetBlindingFactor;
        utxos[i].valueBlindingFactor = valueBlindingFactor;
        unblinded[txid] = utxos[i];
      } catch (e) {
        utxos.splice(i, 1);
      }
    }
  }

  utxos = shuffle(utxos.filter(
    (o) => o.asset === asset && (o.asset !== BTC || o.value > DUST)
  ));

  let i = 0;
  let total = 0;

  while (total < amount) {
    if (i >= utxos.length) {
      throw { message: "Insufficient funds", amount, asset, total };
    }
    total += utxos[i].value;
    i++;
  }

  let blinded = {};
  for (var j = 0; j < i; j++) {
    let prevout = utxos[j];
    let hex = await getHex(prevout.txid);
    let tx = Transaction.fromHex(hex);

    let input = {
      hash: prevout.txid,
      index: prevout.vout,
      redeemScript: redeem.output,
      sighashType,
    };

    if (prevout.assetcommitment) {
      blinded[j] = true;
      input.witnessUtxo = tx.outs[prevout.vout];
    } else {
      input.nonWitnessUtxo = Buffer.from(hex, "hex");
    }

    p.addInput(input);
  }

  if (total > amount)
    if (total - amount > DUST || asset !== BTC) {
      let changeIndex = p.data.outputs.length;

      p.addOutput({
        asset,
        nonce: Buffer.alloc(1),
        script: out.output,
        value: total - amount,
      });

      if (Object.keys(blinded).length > 0) outputsToBlind.push(changeIndex)
    } else bumpFee(total - amount);
};

const blind = async (pset, outputsToBlind) => {
  const inputsData = new Map();
  const outputsKeys = new Map();

  const transaction = pset.__CACHE.__TX;

  // set the outputs map
  for (const index of outputsToBlind) {
    const { script } = transaction.outs[index];
    const pubKey = blindingKey().publicKey;
    outputsKeys.set(index, pubKey);
  }

  // set the inputs map

  for (let index = 0; index < pset.data.inputs.length; index++) {
    const input = pset.data.inputs[index];
    let script = undefined;

    // continue if the input witness is unconfidential
    if (input.witnessUtxo) {
      if (!isConfidentialOutput(input.witnessUtxo)) {
        continue;
      }

      script = input.witnessUtxo.script;
    }

    if (input.nonWitnessUtxo) {
      const vout = transaction.ins[index].index;
      const witness = Transaction.fromBuffer(input.nonWitnessUtxo).outs[vout];
      if (!isConfidentialOutput(witness)) {
        continue;
      }

      script = witness.script;
    }

    if (!script) {
      throw new Error("no witness script for input #" + index);
    }

    const privKey = blindingKey().privateKey;
    const blinders = await confidential.unblindOutputWithKey(
      input.witnessUtxo,
      privKey
    );

    inputsData.set(index, blinders);
  }

  const blinded = await pset.blindOutputsByIndex(inputsData, outputsKeys);
  return blinded;
};

const emptyNonce = Buffer.from("0x00", "hex");

function bufferNotEmptyOrNull(buffer) {
  return buffer != null && buffer.length > 0;
}

function isConfidentialOutput({ rangeProof, surjectionProof, nonce }) {
  return (
    bufferNotEmptyOrNull(rangeProof) &&
    bufferNotEmptyOrNull(surjectionProof) &&
    nonce !== emptyNonce
  );
}

const addFee = (p) =>
  p.addOutput({
    asset: BTC,
    nonce: Buffer.alloc(1, 0),
    script: Buffer.alloc(0),
    value: FEE,
  });

const bumpFee = (v) => fee.set(get(fee) + v);

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

const signAndBroadcast = async () => {
  await tick();
  await sign();
  await tick();
  await broadcast();
  return get(psbt);
};

const createIssuance = async (
  { filename: file, title: name, ticker },
  domain
) => {
  let out = p2wpkh();
  let contract = {
    entity: { domain },
    file,
    issuer_pubkey: keypair().pubkey.toString("hex"),
    name,
    precision: 0,
    ticker,
    version: 0,
  };

  let p = new Psbt()
    // op_return
    .addOutput({
      asset: BTC,
      nonce: Buffer.alloc(1),
      script: payments.embed({ data: [Buffer.from("00")] }).output,
      value: 0,
    });

  await fund(p, out, BTC, FEE);

  let params = {
    assetAmount: 1,
    assetAddress: out.address,
    tokenAmount: 0,
    precision: 0,
    net: network,
    contract,
  };

  console.log("Creating issuance tx with params:", params);
  p.addIssuance(params);

  // p = await blind(p, [p.data.outputs.length - 1]);

  addFee(p);
  console.log("Blinding outputs", outputsToBlind);
  p = await blind(p, outputsToBlind);
  p = await sign(p);
  await broadcast(p);

  return contract;
};

const getAddress = () => {
  return p2wpkh().confidentialAddress;
};

const getHex = async (txid) => {
  return electrs.url(`/tx/${txid}/hex`).get().text();
};

const getTx = async (txid) => {
  return Transaction.fromHex(await getHex(txid));
};

module.exports = {
  faucet,
  createIssuance,
  getAddress,
};
