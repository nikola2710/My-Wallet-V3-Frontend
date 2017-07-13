angular
  .module('walletApp')
  .controller('SendEthereumController', SendEthereumController);

function SendEthereumController ($scope, $window, currency, Alerts, Ethereum, Wallet) {
  const txTemplate = {
    to: null,
    amount: null,
    description: null
  };

  this.account = Ethereum.defaultAccount;
  this.payment = this.account.createPayment();
  this.payment.setGasPrice(10);

  this.refreshTx = () => {
    this.tx = angular.copy(txTemplate);
  };

  this.setSweep = () => {
    this.payment.setSweep();
    this.tx.amount = this.payment.amount;
  };

  this.isAddress = (address) => {
    return Ethereum.isAddress(address);
  };

  this.onScan = (result) => {
    if (this.isAddress(result)) {
      this.tx.to = result;
    }
  };

  this.setTo = () => {
    let { to } = this.tx;
    if (to && this.isAddress(to)) this.payment.setTo(to);
  };

  this.setAmount = () => {
    let { amount } = this.tx;
    if (amount) this.payment.setValue(amount);
  };

  this.nextStep = () => {
    this.payment.sign();
    $scope.vm.toConfirmView();
  };

  this.send = () => {
    this.payment.publish().then(({ txHash }) => {
      $scope.vm.close();
      this.account.fetchBalance();
      console.log('sent ether:', txHash);
      Alerts.displaySuccess('Successfully sent Ether!').then(() => {
        let win = $window.open(`https://etherscan.io/tx/${txHash}`, '__blank');
        win.opener = null;
      });
    });
  };

  this.convertFromEther = (eth) => {
    let fiat = Wallet.settings.currency;
    return currency.formatCurrencyForView(currency.convertFromEther(eth, fiat), fiat, false);
  };

  this.refreshTx();

  this.account.fetchBalance();
  window.ctrl = this;
}
