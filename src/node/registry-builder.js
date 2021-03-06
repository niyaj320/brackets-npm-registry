/*eslint strict:0, no-console:0*/
'use strict';

const _ = require('lodash');
const cheerio = require('cheerio');
const npmKeyword = require('npm-keyword');
const Promise = require('bluebird');
const { all, promisifyAll } = require('bluebird');
const fs = promisifyAll(require('fs-extra'));
const path = require('path');
const request = require('request');
const semver = require('semver');
const logOutput = (...args) => process.stdout.write(args.join(' '), 'utf8');
const logProgress = (...args) => process.stderr.write(args.join(' '), 'utf8');

function calculateDownloadMetrics(extensionInfo) {
  let downloadsArray = extensionInfo.downloads;
  // downloadsLastWeek
  let today = new Date();
  today.setDate(today.getDate() - 7);
  let weekAgo = today.toISOString().substring(0, 10);
  extensionInfo.downloadsLastWeek = downloadsArray
    .filter(obj => obj.day >= weekAgo)
    .reduce((sum, obj) => sum + obj.downloads, 0);
  // downloadsTotal
  extensionInfo.downloadsTotal = downloadsArray
    .reduce((sum, obj) => sum + obj.downloads, 0);
}

function getPackagesFromNpmSearch() { // eslint-disable-line no-unused-vars
  return new Promise((resolve, reject) => {
    request(`http://npmsearch.com/query?q=keywords:brackets-extension&fields=name`,
    (error, response, body) => {

      if (error) { return reject(error); }
      if (!/^2/.test(response.statusCode)) { return reject(body); }
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (err) { return reject(err); }
      }
      const results = [];
      body.results.forEach(x => {
        if (_.isArray(x.name)) {
          x.name.forEach(n => results.push(n));
        } else {
          results.push(x.name);
        }
      });
      resolve(results.sort()); // array of strings

    });
  });
}

// https://registry.npmjs.org/-/_view/byKeyword?startkey=[%22brackets-extension%22]&endkey=[%22brackets-extension%22,%7B%7D]&group_level=2
function getPackagesFromNpmKeyword() {
  return npmKeyword.names('brackets-extension');
}

function npmView(packageName) {
  return new Promise((resolve, reject) => {
    request(`https://registry.npmjs.org/${packageName}`, (error, response, body) => {
      if (error) { return reject(error); }
      if (!/^2/.test(response.statusCode)) { return reject(body); }
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (err) { return reject(err); }
      }

      // cleanup a bit
      delete body.readme;

      resolve(body);
    });
  });
}

function getDownloadCounts(extensionInfos) {
  let from = '2015-01-01';
  let to = new Date().toISOString().substring(0, 10);
  let extensionIds = extensionInfos.map(i => i.name);
  return new Promise((resolve, reject) => {
    request(`https://api.npmjs.org/downloads/range/${from}:${to}/${extensionIds.join(',')}`, (error, response, body) => {

      if (error) { return reject(error); }
      if (!/^2/.test(response.statusCode)) { return reject(body); }
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (err) { return reject(err); }
      }

      if (extensionIds.length === 1) {
        extensionInfos[0].downloads = body.downloads;
        calculateDownloadMetrics(extensionInfos[0]);
      } else {
        extensionInfos.forEach(extensionInfo => {
          let info = body[extensionInfo.name];
          if (info && info.downloads) {
            extensionInfo.downloads = info.downloads;
            calculateDownloadMetrics(extensionInfo);
          }
        });
      }

      resolve(extensionInfos);

    });
  });
}

function buildRegistry(targetFile) {
  logProgress(`getting packages with keyword: brackets-extension`);
  getPackagesFromNpmKeyword()
    .then(searchResults => {
      // call view for all potential extensions
      logProgress(`executing npm view to get detailed info about the extensions (${searchResults.length})`);
      return all(searchResults.map(extensionId => npmView(extensionId)));
    })
    .then(viewResults => {
      logProgress(`got all view results (${viewResults.length})`);
      // filter out those, which doesn't have brackets engine specified in any of the versions
      return viewResults.filter(result => {

        // versions sorted from latest first
        let versions = Object.keys(result.versions).sort((a, b) => -1 * semver.compare(a, b));

        // engine versions found in the versions
        let engines = {};

        // filter out only relevant versions (we don't want duplicates with the same brackets version)
        versions = versions.filter(version => {
          let bracketsEngine = _.get(result.versions[version], 'engines.brackets');
          if (!bracketsEngine || engines[bracketsEngine]) {
            delete result.versions[version];
            return false;
          }
          engines[bracketsEngine] = true;
          return true;
        });

        if (versions.length === 0) {
          logProgress(`filtering out ${result.name} because no valid versions with brackets-engine were found\n`);
          return false;
        }

        // add data from the latest version to the root
        _.defaults(result, result.versions[versions[0]]);

        return true;
      });
    })
    .then(extensionInfos => {
      logProgress(`getting download info counts for the extensions (${extensionInfos.length})`);
      // get download counts for the extensions
      return getDownloadCounts(extensionInfos).catch(err => {
        logProgress(`getDownloadCounts-error: ${err}`);
        return extensionInfos;
      });
    })
    .then(extensionInfos => {
      logProgress(`getting issue/pr counts for the extensions`);
      return Promise.all(extensionInfos.map(extensionInfo => {

        const githubRepo = /https?:\/\/[^\/]*github.com\/([^\/]+)\/([^\/]+)$/;

        let candidates = _.compact([
          extensionInfo.repository ? extensionInfo.repository.url : null,
          extensionInfo.repository,
          extensionInfo.homepage
        ]).filter(x => typeof x === 'string').filter(x => x.match(githubRepo));

        if (candidates.length === 0) {
          return Promise.resolve();
        }

        let m = candidates[0].match(githubRepo);
        let username = m[1];
        let repo = m[2];

        if (repo.match(/\.git$/)) { repo = repo.slice(0, -4); }

        extensionInfo.github = {};
        extensionInfo.github.username = username;
        extensionInfo.github.repository = repo;
        extensionInfo.github.issueCount = -1;
        extensionInfo.github.pullCount = -1;

        let githubIssueCount = NaN;
        let githubPullCount = NaN;

        return new Promise((resolve) => {
          let url = `https://github.com/${username}/${repo}/issues`;
          request({
            url,
            method: `GET`,
            headers: {
              'User-Agent': `brackets-npm-registry`
            }
          }, (error, response, body) => {
            if (error || response.statusCode !== 200) {
              if (response) {
                logProgress(`GET ${url} ERR`, response.statusCode);
              } else {
                logProgress(`GET ${url} ERR`, error);
              }
              return resolve();
            }
            let parsedBody = cheerio.load(body);
            githubIssueCount = parseInt(parsedBody(`a[href="/${username}/${repo}/issues"] .counter`).text(), 10);
            githubPullCount = parseInt(parsedBody(`a[href="/${username}/${repo}/pulls"] .counter`).text(), 10);
            resolve();
          });
        }).then(() => {
          extensionInfo.github.issueCount = isNaN(githubIssueCount) ? -1 : githubIssueCount;
          extensionInfo.github.pullCount = isNaN(githubPullCount) ? -1 : githubPullCount;
        });
      })).then(() => extensionInfos);
    })
    .then(extensionInfos => {
      let strResults = JSON.stringify(extensionInfos, null, 2);
      logProgress(`all done`);
      logOutput(strResults);
      if (targetFile) {
        logProgress(`writing the results to file:\n`, targetFile);
        return fs.ensureDirAsync(path.dirname(targetFile))
          .then(() => fs.writeFileAsync(targetFile, strResults))
          .then(() => extensionInfos);
      }
      return extensionInfos;
    });

}

if (process.argv[1] === __filename) {
  buildRegistry(...process.argv.slice(2));
} else {
  module.exports = buildRegistry;
}

