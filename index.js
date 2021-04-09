const { faucet, createIssuance, getAddress } = require("./wallet");

const main = async () => {
  let artwork = {
    filename: "123.jpg",
    title: "My artwork",
    ticker: "ART"
  };

  try {
    console.log(await faucet(getAddress()));
    console.log(await createIssuance(artwork, "adamsoltys.com"));
  } catch(e) {
    console.log(e);
  } 
} 

main()
