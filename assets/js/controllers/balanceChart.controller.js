angular
  .module('walletApp')
  .controller('BalanceChartController', BalanceChartController);

function BalanceChartController ($scope, $state, Wallet, currency) {
  let fiat = Wallet.settings.currency;
  let cryptoMap = currency.cryptoCurrencyMap;
  let fiatOf = (currency) => cryptoMap[currency].from($scope[currency].total(), fiat);
  let total = fiatOf('btc') + fiatOf('eth') + fiatOf('bch');

  $scope.options = {
    chart: {
      height: 230
    },
    title: {
      text: total,
      align: 'center',
      verticalAlign: 'middle',
      style: {
        fontSize: '18px',
        fontWeight: 'bold'
      }
    },
    plotOptions: {
      pie: {
        allowPointSelect: true,
        cursor: 'pointer',
        dataLabels: { enabled: false },
        events: {
          click: (evt) => $state.go('wallet.common.' + evt.point.id)
        }
      },
      line: {
        marker: {
          enabled: false
        }
      }
    },
    credits: { enabled: false },
    series: [
      {
        type: 'pie',
        name: 'Amount',
        innerSize: '70%',
        cursor: 'pointer',
        data: [
          {
            y: fiatOf('eth'),
            id: 'eth',
            name: 'Ether',
            color: '#004a7c'
          },
          {
            y: fiatOf('btc'),
            id: 'btc',
            name: 'Bitcoin',
            color: '#10ADE4'
          },
          {
            y: fiatOf('bch'),
            id: 'bch',
            name: 'Bitcoin Cash',
            color: '#B2D5E5'
          }
        ]
      }
    ]
  };

  // watch balances and update
}
