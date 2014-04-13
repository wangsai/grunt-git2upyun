/*
 * grunt-git2upyun
 * https://github.com/wangsai/grunt-git2upyun
 *
 * Copyright (c) 2014 wangsai
 * Licensed under the MIT license.
 */

'use strict';

var path = require('path'),
  fs = require('fs'),
  when = require('when'),
  _ = require('lodash'),
  nodefn  = require('when/node/function'),
  git = require('gift'),
  inspect = require('eyes').inspector({ stream: null }),
  UPYun = require('../lib/upyun').UPYun,
  upyun;


var Deploy

module.exports = function(grunt) {

  // Please see the Grunt documentation for more information regarding task
  // creation: http://gruntjs.com/creating-tasks

  grunt.registerMultiTask('git2upyun', 'grunt plugin for git-to-upyun uploader', function() {
    // Merge task-specific and/or target-specific options with these defaults.
    var options = this.options({
      bucketname: '', //空间名称
      username: '', //操作员名称
      password: '', //密码
      root: '/', //文件存储的目录，可以是 '/'

      repository: './', //本地仓库路径
      ignore:[], //忽略哪些文件
      cleanpath: false //上传文件之前会调用此函数处理目标存储路径
    });

    //init UPYUN api
    upyun = new UPYun(options.bucketname, options.username, options.password);

    var localRevision,
      serverRevision,
      reversionFile = path.join(options.root, '.reversion').replace(/\\/g, '/'),
      done = this.async();

    var repository = git(options.repository);


    getLocalRevision(repository).then(function(rev){
      // grunt.log.writeln(inspect(rev));
      localRevision = rev;

      return getServerRevision(upyun, reversionFile);

    }).then(function(rev){
      serverRevision = rev;

      
      if(!rev) {
        return getManagedFiles(repository);
      } else {
        return compare(repository, serverRevision, localRevision);
        // return when({});
      }

    }).then(function(files){

      var filesForUpload = files.filesForUpload || [];
      var filesForDelete = files.filesForDelete || [];
      var excludeFiles = grunt.file.expand({cwd:options.repository}, options.ignore || []);

      filesForUpload = _.difference(filesForUpload, excludeFiles);

      grunt.log.debug('excludeFiles: ', inspect(excludeFiles));

      grunt.log.debug('filesForUpload: ', inspect(filesForUpload));
      grunt.log.debug('filesForDelete: ', inspect(filesForDelete));
      

      return deleteFiles(upyun, options.repository, options.root, filesForDelete, options.cleanpath).then(function(values){
        grunt.log.writeln('Total deleted files: ', values.length);

        return uploadFiles(upyun, options.repository, options.root, filesForUpload, options.cleanpath);
      }).then(function(values){
        grunt.log.writeln('Total uploaded files: ', values.length);

        return updateRevisionFile(upyun, reversionFile, localRevision);
      });

    }).then(function(){
      done();
    }).otherwise(function(e){
      // grunt.log.writeln(inspect(e));
      done(new Error(inspect(e)));
    });


    function getLocalRevision(repo){
      var got = when.defer();

      repo.current_commit_id(function(err, ret){
        if(err) {
          return got.reject(err);
        }

        grunt.log.writeln('LocalRevision:', ret);

        return got.resolve(ret);

      });

      return got.promise;

    }


    function getServerRevision(upyun, path) {
      var got = when.defer();

      grunt.log.debug('Revision File Path:', path);

      upyun.readFile(path, null, function(err, ret){

        grunt.log.writeln('ServerRevision:', ret);

        grunt.log.debug(inspect(err));

        if(err && err.statusCode === 404) {
          return got.resolve('');
        }

        if(err) {
          return got.reject(err);
        }

        return got.resolve(ret);

      });

      return got.promise;
    }

    function getManagedFiles(repo) {
      var files = when.defer();

      repo.ls_files({}, function(err, ret){

        if(err) {
          return files.reject(err);
        }

        // grunt.log.writeln(inspect(_.flatten(ret)));

        return files.resolve({filesForUpload:_.flatten(ret)});

      });

      return files.promise;
    }

    function compare(repo, revisionA, revisionB)
    {
      var files = when.defer(),
        filesForUpload = [],
        filesForDelete = [];

      repo.git('diff', {'name-status':true}, [revisionA, revisionB], function(err, stdout, stderr){
        if(err) {
          files.reject(err);
        }

        // grunt.log.writeln(inspect(stdout.explode('\n')));

        var lines = stdout.split('\n');

        _.forEach(lines, function(line){
          if(line[0] === 'D') {
            filesForDelete.push(line.substr(1).trim());
          } else if(line.length) {
            filesForUpload.push(line.substr(1).trim());
          }

        });

        files.resolve({filesForUpload:filesForUpload, filesForDelete:filesForDelete});
      });

      return files.promise;
    }

    function uploadFiles(upyun, repoPath, root, files, cleanpath) {
      files = files || [];
      var uploadPromises = _.map(files, function(file) {
        var up = when.defer();
        var localFilePath = path.join(repoPath, file);
        var remoteFilePath = path.join(root, file).replace(/\\/g, '/');

        if(grunt.util.kindOf(cleanpath) == 'function') {
        	remoteFilePath = cleanpath(remoteFilePath);
        	grunt.log.debug('Cleaned Path: ', remoteFilePath);
        }


        nodefn.call(fs.readFile, localFilePath).then(function(data){
          return nodefn.call(upyun.writeFile, remoteFilePath, data, true);
        }).then(function(){
          grunt.log.writeln('Uploaded: ', file, ' => ', remoteFilePath);
          up.resolve(file);
        }).otherwise(function(err){
          up.reject(err);
        });

        return up.promise;
      });

      return when.all(uploadPromises);
    }


    function deleteFiles(upyun, repoPath, root, files, cleanpath) {

      files = files || [];
      var deletePromises = _.map(files, function(file) {
        var del = when.defer();
        var remoteFilePath = path.join(root, file).replace(/\\/g, '/');

        if(grunt.util.kindOf(cleanpath) == 'function') {
        	remoteFilePath = cleanpath(remoteFilePath);
        	grunt.log.debug('Cleaned Path: ', remoteFilePath);
        }

        nodefn.call(upyun.deleteFile, remoteFilePath).then(function(){
          del.resolve(file);
        }).otherwise(function(err){
       	  if(!err || (err && err.statusCode === 404)) {
       	  	grunt.log.writeln('Deleted: ', file, ' => ', remoteFilePath);
            return del.resolve(file);
          }

          del.reject(err);
        });

        return del.promise;
      });

      return when.all(deletePromises);
    }


    function updateRevisionFile(upyun, file, revision) {
      return nodefn.call(upyun.writeFile, file, revision, true);
    }


  });

};
