angular
  .module('walletApp')
  .controller('NavigationCtrl', NavigationCtrl);

function NavigationCtrl ($scope, $rootScope, $interval, $timeout, $cookies, $q, $uibModal, Wallet, Alerts, currency, whatsNew, MyWalletMetadata) {
  $scope.status = Wallet.status;
  $scope.settings = Wallet.settings;

  $scope.whatsNewTemplate = 'templates/whats-new.jade';

  $scope.lastViewedWhatsNew = null;

  $scope.getTheme = () => $scope.settings.theme;

  const lastViewedDefaultTime = 1231469665000;

  $scope.initialize = (mockFailure) => {
    const fetchLastViewed = () => {
      if (!Wallet.settings.secondPassword) {
        $scope.metaData = new MyWalletMetadata(2, mockFailure);
        $scope.metaData.fetch().then((res) => {
          if (res !== null) {
            $scope.lastViewedWhatsNew = res.lastViewed;
          } else {
            $scope.metaData.create({
              lastViewed: lastViewedDefaultTime
            }).then(() => {
              $scope.lastViewedWhatsNew = lastViewedDefaultTime;
            });
          }
        }).catch((e) => {
          // Fall back to cookies if metadata service is down
          $scope.lastViewedWhatsNew = $cookies.get('whatsNewViewed') || lastViewedDefaultTime;
        });
      } else {
        // Metadata service doesn't work with 2nd password
        $scope.lastViewedWhatsNew = $cookies.get('whatsNewViewed') || lastViewedDefaultTime;
      }
    };

    if ($scope.status.isLoggedIn) {
      if ($scope.status.didUpgradeToHd) {
        fetchLastViewed();
      } else {
        // Wait for upgrade:
        const watcher = $scope.$watch('status.didUpgradeToHd', (newValue) => {
          if (newValue) {
            watcher();
            fetchLastViewed();
          }
        });
      }
    }
  };

  if (!$rootScope.mock) $scope.initialize();

  let nLatestFeats = null;
  $scope.nLatestFeats = () => {
    if (nLatestFeats === null && $scope.lastViewedWhatsNew !== null) {
      nLatestFeats = whatsNew.filter(({ date }) => date > $scope.lastViewedWhatsNew).length;
    }

    return nLatestFeats;
  };

  $scope.feats = whatsNew;

  $scope.viewedWhatsNew = () => $timeout(() => {
    if ($scope.viewedWhatsNew === null) {
      return;
    }
    nLatestFeats = 0;
    let lastViewed = Date.now();
    $scope.lastViewedWhatsNew = lastViewed;
    if (!Wallet.settings.secondPassword) {
      // Set cookie as a fallback in case metadata service is down
      $cookies.put('whatsNewViewed', lastViewed);
      $scope.metaData.update({
        lastViewed: lastViewed
      });
    } else {
      // Metadata service doesn't work with 2nd password
      $cookies.put('whatsNewViewed', lastViewed);
    }
  });

  $scope.logout = () => {
    let isSynced = Wallet.isSynchronizedWithServer();

    let options = { templateUrl: 'partials/survey-modal.jade', windowClass: 'bc-modal confirm top' };
    let tookSurvey = () => $cookies.put('logout-survey', true);
    let dismissed = (e) => e === 'backdrop click' ? $q.reject(e) : $q.resolve();

    let promptSurvey = () =>
      Boolean($cookies.get('logout-survey')) === true
        ? $q.resolve()
        : $uibModal.open(options).result.then(tookSurvey, dismissed);

    let confirmForce = () =>
      Alerts.confirm('CONFIRM_FORCE_LOGOUT', { modalClass: 'top' });

    let logout = () =>
      Wallet.logout(true);

    isSynced
      ? promptSurvey().then(logout)
      : confirmForce().then(promptSurvey).then(logout);
  };

  if (Wallet.goal.firstTime) {
    $scope.viewedWhatsNew();
  }

  $interval(() => {
    if (Wallet.status.isLoggedIn) currency.fetchExchangeRate();
  }, 15 * 60000);
}
